// A local HTTP/1.1 stub on tokio's `TcpListener`, for the download tests of both engines: #195's, moved
// here for #191 so the summary engine's tests reach it too. Each connection gets one reply, the next
// in a `Sequence`; each request's first line and `Range` header are recorded.
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[derive(Clone)]
pub(crate) enum Reply {
    Body(Vec<u8>),
    Status500,
    /// Headers that promise `claimed` bytes, then `sent`, then the connection closes.
    CloseMidBody { sent: Vec<u8>, claimed: usize },
    /// The body in `chunk`-byte writes, `delay` apart.
    Slow { body: Vec<u8>, chunk: usize, delay: Duration },
    /// `len` copies of `byte`, written without holding them all: the diarizer's 139 MB.
    Fill { byte: u8, len: usize },
    /// Reads the request and never answers, holding the connection open (#298).
    Silent,
    /// Headers that promise `claimed` bytes, then `sent`, then nothing, the connection held open (#298).
    GoesSilent { sent: Vec<u8>, claimed: usize },
    /// Waits, then gives the reply (#298).
    After(Duration, Box<Reply>),
    /// The n-th connection gets the n-th reply, and every later one the last (#298).
    Sequence(Vec<Reply>),
    /// `body`, honouring a `Range: bytes=N-` (#191): 206 with `Content-Range` from N, 416 when N is at or
    /// past its length, and the whole of it with 200 when the request has no Range.
    Ranged(Vec<u8>),
    /// Headers that promise `claimed` bytes, then `sent`, then a wait, then the connection closes; the
    /// instant of the close is recorded in `Stub::closed` just before it (#310).
    CloseAfter { sent: Vec<u8>, claimed: usize, wait: Duration },
}

pub(crate) struct Stub {
    pub base: String,
    pub requests: Arc<Mutex<Vec<String>>>,
    /// Each request's `Range` header, `None` where it sent none, in arrival order (#191).
    pub ranges: Arc<Mutex<Vec<Option<String>>>>,
    pub sent: Arc<AtomicUsize>,
    /// Connections accepted, whether or not they ever sent a request: a TLS ClientHello never does.
    pub accepted: Arc<AtomicUsize>,
    /// When a `CloseAfter` reply closed its connection.
    pub closed: Arc<Mutex<Option<tokio::time::Instant>>>,
}

pub(crate) async fn stub(reply: Reply) -> Stub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let ranges = Arc::new(Mutex::new(Vec::new()));
    let sent = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::new(AtomicUsize::new(0));
    let closed = Arc::new(Mutex::new(None));
    let (requests_in, sent_in, accepted_in, closed_in, ranges_in) = (requests.clone(), sent.clone(), accepted.clone(), closed.clone(), ranges.clone());
    tokio::spawn(async move {
        let mut connections = 0usize;
        while let Ok((mut sock, _)) = listener.accept().await {
            accepted_in.fetch_add(1, Ordering::SeqCst);
            let mut reply = reply.clone();
            if let Reply::Sequence(replies) = &reply {
                reply = replies[connections.min(replies.len() - 1)].clone();
            }
            connections += 1;
            let (requests, sent, closed, ranges) = (requests_in.clone(), sent_in.clone(), closed_in.clone(), ranges_in.clone());
            tokio::spawn(async move {
                let (mut buf, mut got) = (vec![0u8; 8192], Vec::new());
                while !got.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => got.extend_from_slice(&buf[..n]),
                    }
                }
                let head_text = String::from_utf8_lossy(&got).to_string();
                requests.lock().unwrap().push(head_text.lines().next().unwrap_or("").to_string());
                let range = head_text
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("range:"))
                    .map(|l| l[6..].trim().to_string());
                ranges.lock().unwrap().push(range.clone());
                let head = |len: usize| format!("HTTP/1.1 200 OK\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n");
                if let Reply::After(wait, then) = reply {
                    tokio::time::sleep(wait).await;
                    reply = *then;
                }
                match reply {
                    Reply::Silent => std::future::pending::<()>().await,
                    Reply::GoesSilent { sent: part, claimed } => {
                        let _ = sock.write_all(head(claimed).as_bytes()).await;
                        let _ = sock.write_all(&part).await;
                        let _ = sock.flush().await;
                        sent.fetch_add(part.len(), Ordering::SeqCst);
                        std::future::pending::<()>().await
                    }
                    Reply::After(..) | Reply::Sequence(_) => unreachable!("resolved above"),
                    Reply::Ranged(body) => {
                        let from = range
                            .as_deref()
                            .and_then(|r| r.strip_prefix("bytes="))
                            .and_then(|r| r.strip_suffix('-'))
                            .and_then(|n| n.parse::<usize>().ok());
                        match from {
                            None => {
                                let _ = sock.write_all(head(body.len()).as_bytes()).await;
                                let _ = sock.write_all(&body).await;
                                sent.fetch_add(body.len(), Ordering::SeqCst);
                            }
                            Some(n) if n >= body.len() => {
                                let _ = sock
                                    .write_all(format!("HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", body.len()).as_bytes())
                                    .await;
                            }
                            Some(n) => {
                                let part = &body[n..];
                                let _ = sock
                                    .write_all(format!("HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", n, body.len() - 1, body.len(), part.len()).as_bytes())
                                    .await;
                                let _ = sock.write_all(part).await;
                                sent.fetch_add(part.len(), Ordering::SeqCst);
                            }
                        }
                    }
                    Reply::Body(body) => {
                        let _ = sock.write_all(head(body.len()).as_bytes()).await;
                        let _ = sock.write_all(&body).await;
                        sent.fetch_add(body.len(), Ordering::SeqCst);
                    }
                    Reply::Status500 => {
                        let _ = sock.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
                    }
                    Reply::CloseMidBody { sent: part, claimed } => {
                        let _ = sock.write_all(head(claimed).as_bytes()).await;
                        let _ = sock.write_all(&part).await;
                        sent.fetch_add(part.len(), Ordering::SeqCst);
                    }
                    Reply::CloseAfter { sent: part, claimed, wait } => {
                        let _ = sock.write_all(head(claimed).as_bytes()).await;
                        let _ = sock.write_all(&part).await;
                        let _ = sock.flush().await;
                        sent.fetch_add(part.len(), Ordering::SeqCst);
                        tokio::time::sleep(wait).await;
                        // Before the shutdown: on a runtime with more than one thread the engine could
                        // otherwise finish before the instant was written.
                        *closed.lock().unwrap() = Some(tokio::time::Instant::now());
                    }
                    Reply::Fill { byte, len } => {
                        let _ = sock.write_all(head(len).as_bytes()).await;
                        let block = vec![byte; 1 << 16];
                        let mut left = len;
                        while left > 0 {
                            let n = left.min(block.len());
                            if sock.write_all(&block[..n]).await.is_err() {
                                return;
                            }
                            sent.fetch_add(n, Ordering::SeqCst);
                            left -= n;
                        }
                    }
                    Reply::Slow { body, chunk, delay } => {
                        let _ = sock.write_all(head(body.len()).as_bytes()).await;
                        for c in body.chunks(chunk) {
                            if sock.write_all(c).await.is_err() || sock.flush().await.is_err() {
                                return;
                            }
                            sent.fetch_add(c.len(), Ordering::SeqCst);
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
                let _ = sock.shutdown().await;
            });
        }
    });
    Stub { base, requests, ranges, sent, accepted, closed }
}


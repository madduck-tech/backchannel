# ADR 0001: Фундамент приложения — hard fork Conversationaly

Дата: 2026-09-01
Статус: принято

## Контекст

Спека (`realtime-meeting-copilot-mvp-spec.md`, §32–35) требует не писать desktop/audio/STT plumbing с нуля,
а взять существующий OSS meeting stack и надстроить над ним agent-platform слой.
Кандидаты проверены 2026-09-01: Conversationaly, Meetily, Project Raven, NexQ, Vexa Desktop.

## Решение

Базой становится **hard fork `bykof/conversationaly`** (MIT).
Форк создан 2026-09-01 как GitHub fork в организации `madduck-tech`: https://github.com/madduck-tech/backchannel
(ветка `main`, public). Meetily напрямую не форкаем. Raven, NexQ и Vexa Desktop используем только как reference.

## Почему

- Conversationaly сам является hard fork Meetily (`Zackriya-Solutions/meeting-minutes`, MIT) с точки 2026-06-05,
  разошёлся с ним на ~58k удалённых строк. Из него уже убраны Python backend, платная лицензия, телеметрия
  и дублирующие STT-движки. Апстрим Meetily тянуть обратно всё равно нереально.
- Единый STT-рантайм transcribe.cpp (MIT, GGUF на ggml) с каталогом ~85 моделей, включая
  `nemotron-3.5-asr-streaming-0.6b` (streaming, в метаданных есть `ru-RU`) и GigaAM v3.
- Встроенный llama.cpp sidecar, SQLite через sqlx с миграциями, CI на macOS/Windows/Linux,
  сборки под Metal/CUDA/Vulkan/ROCm, VAD, шумоподавление, обработка устройств и разрешений.
- Вся цепочка лицензий MIT: Conversationaly → Meetily, transcribe.cpp, llama.cpp.

## Что фундамент НЕ даёт (наша работа)

- Микрофон и системный звук смешиваются до STT (`pipeline.rs`). Раздельные потоки YOU/OTHERS нужно строить самим.
- transcribe.cpp допускает одну активную сессию на загруженную модель: два потока = две загруженные модели.
- Нет overlay, content protection, хоткеев.
- LLM используется только после встречи; realtime-контура нет.
- Нет echo cancellation, RAG, MCP, агентов.
- Linux system audio держится на эвристике поиска PulseAudio `monitor`-источников через cpal/ALSA.

## Риски

- Bus factor 1 и у Conversationaly, и у transcribe.cpp. Ревизии пинуем, при необходимости вендорим.
- Conversationaly существует три недели (первый коммит форка 2026-08-06); возможна заброшенность.
  Для hard fork это приемлемо.

## Reference-проекты

- `Laxcorp-Research/project-raven` (MIT, Electron): dual streams YOU/THEM, WebRTC AEC3 + residual echo gate,
  overlay с content protection, детект встречи по заголовкам окон, локальный RAG, «спроси по всем встречам».
- `naxhq/NexQ` (MIT, Tauri): конфигурация overlay-окна в Tauri, dual-party capture на Rust. Только Windows.
- `Vexa-ai/vexa-desktop` (MIT/Apache-2): таблица захвата звука по ОС. Ценность низкая.

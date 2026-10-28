use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: Option<String>,
    pub title: String,
    pub body: String,
    pub notification_type: NotificationType,
    pub priority: NotificationPriority,
    pub timeout: NotificationTimeout,
    pub icon: Option<String>,
    pub sound: bool,
    pub actions: Vec<NotificationAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NotificationType {
    RecordingStarted,
    RecordingStopped,
    RecordingPaused,
    RecordingResumed,
    TranscriptionComplete,
    MeetingReminder(u64), // Duration in minutes
    SystemError(String),
    Test, // For testing notifications
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub enum NotificationPriority {
    Low,
    #[default]
    Normal,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[derive(Default)]
pub enum NotificationTimeout {
    Never,
    Seconds(u64),
    #[default]
    Default,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationAction {
    pub id: String,
    pub title: String,
    pub action_type: NotificationActionType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum NotificationActionType {
    Button,
    Reply,
}

impl Notification {
    pub fn new(title: impl Into<String>, body: impl Into<String>, notification_type: NotificationType) -> Self {
        Self {
            id: None,
            title: title.into(),
            body: body.into(),
            notification_type,
            priority: NotificationPriority::Normal,
            timeout: NotificationTimeout::Default,
            icon: None,
            sound: true,
            actions: vec![],
        }
    }

    pub fn with_priority(mut self, priority: NotificationPriority) -> Self {
        self.priority = priority;
        self
    }

    pub fn with_timeout(mut self, timeout: NotificationTimeout) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_sound(mut self, sound: bool) -> Self {
        self.sound = sound;
        self
    }

    pub fn with_icon(mut self, icon: impl Into<String>) -> Self {
        self.icon = Some(icon.into());
        self
    }

    pub fn with_id(mut self, id: impl Into<String>) -> Self {
        self.id = Some(id.into());
        self
    }

    pub fn add_action(mut self, action: NotificationAction) -> Self {
        self.actions.push(action);
        self
    }
}



// Helper functions for creating common notifications
impl Notification {
    /// The consent sentence is in every start notice. It used to go when the start carried a meeting
    /// name, which no start did until #242 made the name arrive; so making it arrive would have
    /// dropped the one line that asks the person to tell the others they are being recorded.
    pub fn recording_started(meeting_name: Option<String>) -> Self {
        const CONSENT: &str = "Please inform others in the meeting that you are recording.";
        let body = match meeting_name {
            Some(name) => format!("Recording started for meeting: {name}. {CONSENT}"),
            None => format!("Recording has started. {CONSENT}"),
        };

        Notification::new("Backchannel", body, NotificationType::RecordingStarted)
            .with_priority(NotificationPriority::High)
            .with_timeout(NotificationTimeout::Seconds(5))
    }

    pub fn recording_stopped() -> Self {
        Notification::new(
            "Backchannel",
            "Recording has been stopped and saved",
            NotificationType::RecordingStopped
        )
        .with_priority(NotificationPriority::Normal)
        .with_timeout(NotificationTimeout::Seconds(3))
    }

    pub fn recording_paused() -> Self {
        Notification::new(
            "Backchannel",
            "Recording has been paused",
            NotificationType::RecordingPaused
        )
        .with_priority(NotificationPriority::Normal)
        .with_timeout(NotificationTimeout::Seconds(3))
    }

    pub fn recording_resumed() -> Self {
        Notification::new(
            "Backchannel",
            "Recording has been resumed",
            NotificationType::RecordingResumed
        )
        .with_priority(NotificationPriority::Normal)
        .with_timeout(NotificationTimeout::Seconds(3))
    }

    pub fn transcription_complete(file_path: Option<String>) -> Self {
        let body = match file_path {
            Some(path) => format!("Transcription completed and saved to: {}", path),
            None => "Transcription has been completed".to_string(),
        };

        Notification::new("Backchannel", body, NotificationType::TranscriptionComplete)
            .with_priority(NotificationPriority::Normal)
            .with_timeout(NotificationTimeout::Seconds(5))
    }

    pub fn meeting_reminder(minutes_until: u64, meeting_title: Option<String>) -> Self {
        let body = match meeting_title {
            Some(title) => format!("Meeting '{}' starts in {} minutes", title, minutes_until),
            None => format!("Meeting starts in {} minutes", minutes_until),
        };

        Notification::new("Backchannel", body, NotificationType::MeetingReminder(minutes_until))
            .with_priority(NotificationPriority::High)
            .with_timeout(NotificationTimeout::Seconds(10))
    }

    pub fn system_error(error: impl Into<String>) -> Self {
        let error_string = error.into();
        Notification::new(
            "Backchannel Error",
            error_string.clone(),
            NotificationType::SystemError(error_string)
        )
        .with_priority(NotificationPriority::Critical)
        .with_timeout(NotificationTimeout::Never)
    }

    pub fn test_notification() -> Self {
        Notification::new(
            "Backchannel",
            "This is a test notification to verify the system is working correctly",
            NotificationType::Test
        )
        .with_priority(NotificationPriority::Normal)
        .with_timeout(NotificationTimeout::Seconds(5))
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    /// #242: with the meeting's name arriving at last, the notice still asks the person to tell the
    /// others they are recording.
    #[test]
    fn every_start_notice_asks_the_person_to_tell_the_others() {
        for name in [None, Some("Meeting 2026-10-28_10-31-30".to_string())] {
            let n = Notification::recording_started(name.clone());
            assert!(n.body.contains("Please inform others in the meeting that you are recording."), "{name:?}: {}", n.body);
            if let Some(name) = name {
                assert!(n.body.contains(&name), "the notice does not name the meeting: {}", n.body);
            }
        }
    }
}

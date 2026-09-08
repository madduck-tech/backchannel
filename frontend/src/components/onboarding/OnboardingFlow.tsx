import React, { useEffect } from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import {
  TranscriptionModelStep,
  SummariserStep,
  DownloadProgressStep,
  AudioCheckStep,
  PermissionsStep,
} from './steps';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { currentStep } = useOnboarding();
  const [isMac, setIsMac] = React.useState(false);

  useEffect(() => {
    // Check if running on macOS
    const checkPlatform = async () => {
      try {
        // Dynamic import to avoid SSR issues if any
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        console.error('Failed to detect platform:', e);
        // Fallback
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    checkPlatform();
  }, []);

  // The flow opens on the first real decision.
  //
  // Two screens used to come before it. `WelcomeStep` was a heading, three claims and one button;
  // `SetupOverviewStep` was 113 lines whose only computed value was `totalSteps={isMac ? 4 : 3}`.
  // On Linux and Windows a new user clicked twice through screens that asked nothing before
  // anything happened. Both are deleted. #111.
  //
  // The three claims went with them, and that is the point rather than a loss: "Your data never
  // leaves your device" was an absolute the user could falsify a minute later by choosing a cloud
  // summariser, with nothing at the point of choice saying so. Each provider option now names its
  // own destination.
  //
  // Step numbers are unchanged so a half-finished onboarding resumes where it was: `currentStep`
  // is persisted (`OnboardingContext.tsx:417-428`), and renumbering would send anyone mid-flow to
  // the wrong screen.
  //
  // Step 1: Transcription - which model turns speech into text, out of a catalogue of 86
  // Step 2: Summariser  - which one writes the summary, and whether anything leaves this machine
  // Step 3: Download    - what the two choices above selected, and nothing else
  // Step 4: Audio check - prove each device with words, not a moving bar. Offered, not mandatory.
  // Step 5: Permissions - microphone and system audio (macOS only)
  //
  // macOS keeps its permissions step last, because the audio check needs the permission it grants.

  return (
    <div className="onboarding-flow">
      {currentStep === 1 && <TranscriptionModelStep />}
      {currentStep === 2 && <SummariserStep />}
      {currentStep === 3 && <DownloadProgressStep />}
      {currentStep === 4 && <AudioCheckStep />}
      {currentStep === 5 && isMac && <PermissionsStep />}
    </div>
  );
}

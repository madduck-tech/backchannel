export type OnboardingStep = 1 | 2 | 3 | 4;

export type PermissionStatus = 'checking' | 'not_determined' | 'authorized' | 'denied';

export interface OnboardingPermissions {
  microphone: PermissionStatus;
  systemAudio: PermissionStatus;
  screenRecording: PermissionStatus;
}

export interface OnboardingContainerProps {
  /** The persistent footer of the approved shell: a readout and the primary action. #154 */
  footer?: React.ReactNode;
  /** The scrolling region, so a step can bring its own chosen row to the top of it. */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
  step?: number;
  totalSteps?: number;
  hideProgress?: boolean;
  className?: string;
}

export interface PermissionRowProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  status: PermissionStatus;
  isPending?: boolean;
  onAction: () => void;
}

export interface StatusIndicatorProps {
  status: 'idle' | 'checking' | 'success' | 'error';
  size?: 'sm' | 'md' | 'lg';
}

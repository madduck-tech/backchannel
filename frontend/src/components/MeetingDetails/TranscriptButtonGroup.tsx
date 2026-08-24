"use client";

import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, FolderOpen, Loader2, RefreshCw, Users } from 'lucide-react';
import { RetranscribeDialog } from './RetranscribeDialog';
import { useSpeakerLabelling } from '@/hooks/useSpeakerLabelling';


interface TranscriptButtonGroupProps {
  transcriptCount: number;
  onCopyTranscript: () => void;
  onOpenMeetingFolder: () => Promise<void>;
  meetingId?: string;
  meetingFolderPath?: string | null;
  onRefetchTranscripts?: () => Promise<void>;
}


export function TranscriptButtonGroup({
  transcriptCount,
  onCopyTranscript,
  onOpenMeetingFolder,
  meetingId,
  meetingFolderPath,
  onRefetchTranscripts,
}: TranscriptButtonGroupProps) {
  const [showRetranscribeDialog, setShowRetranscribeDialog] = useState(false);

  const handleRetranscribeComplete = useCallback(async () => {
    // Refetch transcripts to show the updated data
    if (onRefetchTranscripts) {
      await onRefetchTranscripts();
    }
  }, [onRefetchTranscripts]);

  // Separate from Retranscribe on purpose: labelling never rewrites the text,
  // so folding it into that dialog would mean you cannot get speakers without
  // also re-running the transcript.
  const { labelSpeakers, isLabelling } = useSpeakerLabelling({
    meetingId,
    meetingFolderPath,
    onComplete: handleRetranscribeComplete,
  });

  return (
    <div className="flex items-center justify-center w-full gap-2">
      <ButtonGroup>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onCopyTranscript();
          }}
          disabled={transcriptCount === 0}
          title={transcriptCount === 0 ? 'No transcript available' : 'Copy Transcript'}
        >
          <Copy />
          <span className="hidden lg:inline">Copy</span>
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="xl:px-4"
          onClick={() => {
            onOpenMeetingFolder();
          }}
          title="Open Recording Folder"
        >
          <FolderOpen className="xl:mr-2" size={18} />
          <span className="hidden lg:inline">Recording</span>
        </Button>

        {meetingId && meetingFolderPath && (
          <Button
            size="sm"
            variant="outline"
            className="xl:px-4"
            onClick={() => {
              setShowRetranscribeDialog(true);
            }}
            title="Retranscribe to enhance your recorded audio"
          >
            <RefreshCw className="xl:mr-2" size={18} />
            <span className="hidden lg:inline">Retranscribe</span>
          </Button>
        )}

        {meetingId && meetingFolderPath && (
          <Button
            size="sm"
            variant="outline"
            className="xl:px-4"
            onClick={() => {
              labelSpeakers({ downloadIfMissing: true });
            }}
            disabled={isLabelling || transcriptCount === 0}
            title={
              transcriptCount === 0
                ? 'No transcript to label'
                : 'Detect who spoke and label the transcript'
            }
          >
            {isLabelling ? (
              <Loader2 className="xl:mr-2 animate-spin" size={18} />
            ) : (
              <Users className="xl:mr-2" size={18} />
            )}
            <span className="hidden lg:inline">Speakers</span>
          </Button>
        )}
      </ButtonGroup>

      {meetingId && meetingFolderPath && (
        <RetranscribeDialog
          open={showRetranscribeDialog}
          onOpenChange={setShowRetranscribeDialog}
          meetingId={meetingId}
          meetingFolderPath={meetingFolderPath}
          onComplete={handleRetranscribeComplete}
        />
      )}
    </div>
  );
}

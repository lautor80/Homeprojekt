import { useEffect, useState } from 'react';
import { Bar, Button, Dialog, Label, TextArea, Text, FlexBox } from '@ui5/webcomponents-react';

interface Props {
  open: boolean;
  title: string;
  text: string;
  confirmText?: string;
  /** Begründung abfragen (Pflichtfeld) – z. B. für Löschen/Storno */
  askReason?: boolean;
  danger?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

/** Sicherheitsabfrage, optional mit Pflicht-Begründung für den Änderungsbeleg. */
export function ConfirmDialog({ open, title, text, confirmText = 'OK', askReason, danger, onConfirm, onCancel }: Props) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const disabled = !!askReason && !reason.trim();

  return (
    <Dialog
      open={open}
      headerText={title}
      state={danger ? 'Negative' : 'None'}
      onClose={onCancel}
      footer={
        <Bar
          endContent={
            <>
              <Button design={danger ? 'Negative' : 'Emphasized'} disabled={disabled} onClick={() => onConfirm(reason.trim())}>
                {confirmText}
              </Button>
              <Button onClick={onCancel}>Abbrechen</Button>
            </>
          }
        />
      }
    >
      <FlexBox direction="Column" style={{ gap: '0.75rem', minWidth: 'min(420px, 80vw)' }}>
        <Text>{text}</Text>
        {askReason && (
          <>
            <Label required>Begründung</Label>
            <TextArea rows={3} value={reason} onInput={(e) => setReason(e.target.value)} />
          </>
        )}
      </FlexBox>
    </Dialog>
  );
}

import type { ReactNode } from 'react';
import { CheckBox, Input, Label, TextArea } from '@ui5/webcomponents-react';

/** Einfaches, responsives Formularraster (Label oben, 1–2 Spalten). */
export function FormGrid({ children, columns = 2 }: { children: ReactNode; columns?: 1 | 2 }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: columns === 2 ? 'repeat(auto-fit, minmax(260px, 1fr))' : '1fr',
      gap: '0.75rem 1.5rem',
    }}>
      {children}
    </div>
  );
}

export function FieldBox({ label, required, children, wide }: { label: string; required?: boolean; children: ReactNode; wide?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', gridColumn: wide ? '1 / -1' : undefined }}>
      <Label required={required} showColon>{label}</Label>
      {children}
    </div>
  );
}

interface TextFieldProps {
  label: string;
  value: string | null | undefined;
  onChange?: (v: string) => void;
  required?: boolean;
  readonly?: boolean;
  type?: 'Text' | 'Email' | 'Tel' | 'Password' | 'Number';
  wide?: boolean;
  multiline?: boolean;
  placeholder?: string;
}

export function TextField({ label, value, onChange, required, readonly, type = 'Text', wide, multiline, placeholder }: TextFieldProps) {
  return (
    <FieldBox label={label} required={required} wide={wide}>
      {multiline ? (
        <TextArea rows={4} value={value ?? ''} readonly={readonly} placeholder={placeholder}
                  onInput={(e) => onChange?.(e.target.value)} />
      ) : (
        <Input style={{ width: '100%' }} type={type} value={value ?? ''} readonly={readonly} placeholder={placeholder}
               onInput={(e) => onChange?.(e.target.value)} />
      )}
    </FieldBox>
  );
}

export function CheckField({ label, checked, onChange, readonly }: { label: string; checked: boolean; onChange?: (v: boolean) => void; readonly?: boolean }) {
  return (
    <FieldBox label={label}>
      <CheckBox checked={checked} readonly={readonly} onChange={(e) => onChange?.(e.target.checked)} />
    </FieldBox>
  );
}

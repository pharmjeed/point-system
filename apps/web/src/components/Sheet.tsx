import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { IconButton } from './IconButton';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  /** Static rendering inside the page (component gallery). */
  inline?: boolean;
}

/** Bottom sheet for long choices — spots, slots, events — and the connection details (03 §3.14). */
export function Sheet({ open, onOpenChange, title, children, inline }: SheetProps) {
  const head = (titleNode: ReactNode, close: ReactNode) => (
    <>
      <span className="pt-sheet__grip" aria-hidden="true" />
      <div className="pt-sheet__head">
        {titleNode}
        {close}
      </div>
      <div className="pt-sheet__body">{children}</div>
    </>
  );
  if (inline) {
    return (
      <div className="pt-sheet-backdrop pt-sheet-backdrop--inline">
        <div className="pt-sheet" role="dialog" aria-label={title}>
          {head(
            <h2 className="pt-sheet__title">{title}</h2>,
            <IconButton icon={X} label={components.close} />,
          )}
        </div>
      </div>
    );
  }
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="pt-sheet-backdrop" />
        <RadixDialog.Content className="pt-sheet" aria-describedby={undefined}>
          {head(
            <RadixDialog.Title className="pt-sheet__title">{title}</RadixDialog.Title>,
            <RadixDialog.Close asChild>
              <IconButton icon={X} label={components.close} />
            </RadixDialog.Close>,
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

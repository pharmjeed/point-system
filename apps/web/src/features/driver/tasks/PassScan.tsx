import { useEffect, useRef, useState } from 'react';
import { Banner, Button, Sheet } from '@/components';
import { d05 } from '@/i18n/ar';
import { cameraProblemOf, passTokenOf, startPassScanner } from '../passScan';

type ScanState = 'starting' | 'scanning' | 'checking' | 'failed' | 'denied' | 'unavailable';

/**
 * «مسح بطاقة العميل» (D-05, O-01; V2-013, DEC-500): a Sheet with the rear camera. The first entry pass decoded stops
 * the camera and goes to `onToken` (the intake command); a refusal — `PASS_INVALID`, `PASS_EXPIRED` or any other — is
 * shown under the video with «امسح مجددًا», which starts the camera again (the refused code itself, still on the
 * customer's screen until it rotates, is not sent twice). A QR that is not an entry pass is ignored with a hint.
 */
export function PassScanSheet({
  open,
  onOpenChange,
  onToken,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** resolves when the intake succeeded (the caller closes the sheet), rejects to keep it open with `error` */
  onToken: (token: string) => Promise<void>;
  error: string | null;
}) {
  // a callback ref: the video exists once the sheet's portal has rendered
  const [video, setVideo] = useState<HTMLVideoElement | null>(null);
  const [state, setState] = useState<ScanState>('starting');
  const [notPass, setNotPass] = useState(false);
  const [round, setRound] = useState(0);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  /** tokens the server refused: the same code still on the customer's screen is not sent again */
  const refused = useRef(new Set<string>());

  useEffect(() => {
    if (!open || !video) return;
    let stop: (() => void) | null = null;
    let done = false;
    setState('starting');
    setNotPass(false);
    startPassScanner(video, (text) => {
      if (done) return;
      const token = passTokenOf(text);
      if (!token) {
        setNotPass(true);
        return;
      }
      if (refused.current.has(token)) return;
      done = true;
      stop?.();
      setState('checking');
      onTokenRef.current(token).catch(() => {
        refused.current.add(token);
        setState('failed');
      });
    })
      .then((s) => {
        if (done) s();
        else {
          stop = s;
          setState('scanning');
        }
      })
      .catch((e: unknown) => {
        if (!done) setState(cameraProblemOf(e));
      });
    return () => {
      done = true;
      stop?.();
    };
  }, [open, video, round]);

  const problem =
    state === 'denied' ? d05.pass.cameraDenied : state === 'unavailable' ? d05.pass.cameraUnavailable : null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={d05.pass.sheetTitle}>
      <div className="flex flex-col gap-3" data-pass-scanner={state}>
        <p className="m-0">{d05.pass.aim}</p>
        <video
          ref={setVideo}
          className="aspect-square w-full rounded-lg bg-black object-cover"
          muted
          playsInline
          aria-label={d05.pass.sheetTitle}
        />
        {state === 'starting' ? <p className="m-0 text-text-muted">{d05.pass.starting}</p> : null}
        {state === 'checking' ? (
          <p className="m-0 text-text-muted" role="status">
            {d05.pass.checking}
          </p>
        ) : null}
        {problem ? <Banner kind="error" rounded message={problem} /> : null}
        {state === 'failed' && error ? <Banner kind="error" rounded message={error} /> : null}
        {notPass && state === 'scanning' ? (
          <Banner kind="warning" rounded message={d05.pass.notPass} />
        ) : null}
        {state === 'failed' || problem ? (
          <Button variant="secondary" id="pass-rescan" onClick={() => setRound((n) => n + 1)}>
            {d05.pass.retry}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}

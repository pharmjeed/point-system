import { Sheet } from '@/components';
import { useBrand } from '@/hooks/useMe';
import { d14 } from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';

/** «دليل الإضافة للشاشة الرئيسية» (02 D-14, shared with D-03): iPhone steps, Android, and the push caveat. */
export function InstallGuideSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const brand = useBrand();
  const b = { brand: brand.staffNameAr };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={fmt(d14.addToHomeLink, b)}>
      <div className="flex flex-col gap-3">
        <section aria-labelledby="guide-iphone">
          <h3 className="pt-section-title" id="guide-iphone">
            <bdi dir="ltr" lang="en">
              iPhone
            </bdi>
          </h3>
          <ol className="m-0 flex flex-col gap-1 ps-5">
            {d14.guide.iphone.map((step) => (
              <li key={step}>{fmt(step, b)}</li>
            ))}
          </ol>
          <p className="m-0 mt-2 text-sm text-text-muted">{d14.guide.iphoneNote}</p>
        </section>
        <section aria-labelledby="guide-android">
          <h3 className="pt-section-title" id="guide-android">
            <bdi dir="ltr" lang="en">
              Android
            </bdi>
          </h3>
          <p className="m-0">{d14.guide.android}</p>
        </section>
        <p className="m-0 text-sm text-text-muted">{fmt(d14.guide.all, b)}</p>
      </div>
    </Sheet>
  );
}

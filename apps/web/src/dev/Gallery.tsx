/**
 * Component gallery — development and e2e only (route /_gallery, built when VITE_ENABLE_GALLERY=true).
 * Mirrors docs/design/system/components/<Name>/preview.html: every component, its main states, light and
 * dark side by side, for visual comparison with docs/design/system/screenshots/<Name>.png.
 * Sample data here is illustrative; product copy comes from src/i18n/ar.ts.
 */
import {
  BellRing,
  CarFront,
  Clock,
  KeyRound,
  MapPin,
  Plus,
  Search,
  TriangleAlert,
  Users,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useState, type ReactNode } from 'react';
import type { DriverState, TicketStatus } from '@/api/types';
import {
  AlertItem,
  AppShell,
  Banner,
  BottomNav,
  Button,
  Card,
  Checkbox,
  CodeInput,
  ColorChips,
  ConnectionIndicator,
  CountdownRing,
  DataTable,
  Dialog,
  DriverRow,
  DriverStateChip,
  EmptyState,
  FilterChips,
  Header,
  IconButton,
  KpiStrip,
  KpiTile,
  LetterPad,
  ListItem,
  Logo,
  MaskedPhone,
  OfferCard,
  PhoneInput,
  PhotoGrid,
  CarGlyph,
  PlateBadge,
  PlateInput,
  QrPanel,
  QueueItem,
  Radio,
  SearchField,
  SegmentedControl,
  Select,
  Sheet,
  SideNav,
  Skeleton,
  SpotGrid,
  StatusChip,
  Stepper,
  TaskCard,
  TaskRow,
  TextArea,
  TextField,
  Timeline,
  Toast,
  Toggle,
  TopBar,
  type PlateLetter,
} from '@/components';
import { DRIVER_NAV } from '@/features/driver/DriverLayout';
import { STAFF_NAV } from '@/features/ops/StaffLayout';
import { useBrand } from '@/hooks/useMe';
import {
  alertType,
  components,
  d01,
  d02,
  d03,
  d04,
  d14,
  d15,
  mediaKind,
  ticketStatus,
  vehicleMake,
} from '@/i18n/ar';
import { fmt } from '@/i18n/fmt';
import { useThemeArea } from '@/hooks/useThemeArea';

const TICKET_STATUSES = Object.keys(ticketStatus) as TicketStatus[];
const DRIVER_STATES: DriverState[] = [
  'available',
  'intake_parking',
  'retrieving',
  'busy_with_next',
  'on_break',
  'off_duty',
];
const PLATE = { digits: '1234', letters: ['ب', 'ح', 'د'], lettersEn: ['B', 'J', 'D'] };
const CAR = { type: 'sedan', color: 'white' } as const;
const VEHICLE = `${vehicleMake.toyota} كامري · أبيض`;
const iso = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();

function Modes({ children }: { children: (theme: 'light' | 'dark') => ReactNode }) {
  return (
    <div className="pt-modes">
      {(['light', 'dark'] as const).map((theme) => (
        <section key={theme} className="pt-mode" data-theme={theme} dir="rtl" lang="ar">
          <span className="pt-mode__tag">{theme === 'light' ? d14.themeLight : d14.themeDark}</span>
          <div className="pt-mode__body">{children(theme)}</div>
        </section>
      ))}
    </div>
  );
}

function State({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <figure className={`pt-state${wide ? ' pt-state--wide' : ''}`}>
      <figcaption>{label}</figcaption>
      <div className="pt-state__body">{children}</div>
    </figure>
  );
}

function Section({ name, children }: { name: string; children: (theme: 'light' | 'dark') => ReactNode }) {
  return (
    <section id={`gallery-${name}`} data-gallery={name} className="flex flex-col gap-2">
      <h2 className="pt-section-title" dir="ltr">
        {name}
      </h2>
      <Modes>{children}</Modes>
    </section>
  );
}

function PlateInputDemo() {
  const [digits, setDigits] = useState('1234');
  const [letters, setLetters] = useState<PlateLetter[]>([
    ['ب', 'B'],
    ['ح', 'J'],
  ]);
  const [other, setOther] = useState(false);
  const [raw, setRaw] = useState('');
  return (
    <PlateInput
      digits={digits}
      letters={letters}
      onDigitsChange={setDigits}
      onLettersChange={setLetters}
      other={other}
      onOtherChange={setOther}
      raw={raw}
      onRawChange={setRaw}
    />
  );
}

function useGalleryState() {
  const [code, setCode] = useState('12');
  const [seg, setSeg] = useState<'system' | 'light' | 'dark'>('system');
  const [filters, setFilters] = useState<string[]>(['requested']);
  const [color, setColor] = useState<'white' | 'black' | 'silver'>('white');
  const [spot, setSpot] = useState('A-03');
  const [search, setSearch] = useState('12');
  const [toggle, setToggle] = useState(true);
  const [radio, setRadio] = useState('cash');
  return {
    code,
    setCode,
    seg,
    setSeg,
    filters,
    setFilters,
    color,
    setColor,
    spot,
    setSpot,
    search,
    setSearch,
    toggle,
    setToggle,
    radio,
    setRadio,
  };
}

export default function Gallery() {
  useThemeArea('driver');
  const brand = useBrand();
  const s = useGalleryState();
  const [qrSvg, setQrSvg] = useState('');
  useEffect(() => {
    void QRCode.toString('https://wa.me/966500000000?text=LINK-K7Q2', {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 4,
    }).then(setQrSvg);
  }, []);

  return (
    <div className="flex flex-col gap-8 p-4" data-theme="light" style={{ background: 'var(--pt-bg)' }}>
      <Section name="Logo">
        {(theme) => (
          <>
            <State label="mark 28px">
              <Logo variant="mark" height={28} alt={brand.staffNameAr} theme={theme} />
            </State>
            <State label="lockup-rtl">
              <Logo variant="lockup-rtl" height={32} alt={brand.staffNameAr} theme={theme} />
            </State>
            <State label="stacked">
              <Logo variant="stacked" height={120} alt={brand.staffNameAr} theme={theme} />
            </State>
          </>
        )}
      </Section>

      <Section name="Button">
        {() => (
          <>
            <div className="pt-staterow">
              <State label="primary">
                <Button>{components.offer.accept}</Button>
              </State>
              <State label="loading">
                <Button loading>{components.offer.accept}</Button>
              </State>
              <State label="disabled">
                <Button disabled>{components.offer.accept}</Button>
              </State>
              <State label="done">
                <Button variant="success" done>
                  {d02.submit}
                </Button>
              </State>
            </div>
            <State label="error" wide>
              <Button variant="secondary" error={fmt(d15.offline, { time: '7:42 م' })}>
                {components.photo.retry}
              </Button>
            </State>
            <div className="pt-staterow">
              <State label="variants" wide>
                <Button iconStart={Plus}>{d04.intake}</Button>
                <Button variant="secondary">{d01.staffLink}</Button>
                <Button variant="ghost">{d14.logout}</Button>
                <Button variant="danger">{ticketStatus.voided}</Button>
                <Button variant="success">{components.stepper.handover}</Button>
                <Button variant="reserve">{components.offer.reserve}</Button>
              </State>
            </div>
            <State label="lg 56px" wide>
              <Button size="lg">{d03.start}</Button>
            </State>
          </>
        )}
      </Section>

      <Section name="IconButton">
        {() => (
          <div className="pt-staterow">
            <State label="ghost">
              <IconButton icon={Search} label={components.search.label} />
            </State>
            <State label="secondary">
              <IconButton icon={Search} label={components.search.label} variant="secondary" />
            </State>
            <State label="primary + badge">
              <IconButton icon={BellRing} label={d14.alerts} variant="primary" badge={3} />
            </State>
            <State label="loading">
              <IconButton icon={Search} label={components.search.label} loading />
            </State>
          </div>
        )}
      </Section>

      <Section name="StatusChip">
        {() => (
          <div className="pt-staterow">
            {TICKET_STATUSES.map((st) => (
              <StatusChip key={st} status={st} />
            ))}
          </div>
        )}
      </Section>

      <Section name="DriverStateChip">
        {() => (
          <div className="pt-staterow">
            {DRIVER_STATES.map((st) => (
              <DriverStateChip key={st} state={st} />
            ))}
          </div>
        )}
      </Section>

      <Section name="ConnectionIndicator">
        {() => (
          <div className="pt-staterow">
            <ConnectionIndicator state="online" />
            <ConnectionIndicator state="uncertain" lastSync="23:04" />
            <ConnectionIndicator state="offline" lastSync="22:58" />
          </div>
        )}
      </Section>

      <Section name="TopBar">
        {() => (
          <>
            <TopBar title={brand.staffNameAr} driverState="available" connection="online" />
            <TopBar
              title={brand.staffNameAr}
              driverState="retrieving"
              connection="uncertain"
              lastSync="23:04"
            />
            <TopBar title="قاعة ريماس" connection="offline" lastSync="22:58" />
          </>
        )}
      </Section>

      <Section name="BottomNav">{() => <BottomNav items={DRIVER_NAV} />}</Section>

      <Section name="SideNav">
        {() => <SideNav items={STAFF_NAV} brandName={brand.staffNameAr} onLogout={() => undefined} />}
      </Section>

      <Section name="AppShell">
        {() => (
          <div
            style={{
              blockSize: 560,
              overflow: 'hidden',
              border: '1px solid var(--pt-border)',
              borderRadius: 16,
            }}
          >
            <AppShell
              topBar={<TopBar title={brand.staffNameAr} driverState="available" />}
              bottomNav={<BottomNav items={DRIVER_NAV} />}
              offer={
                <OfferCard
                  offerId="o1"
                  mode="single"
                  ticketNumber={125}
                  vehicleSummary={VEHICLE}
                  plate={PLATE}
                  car={CAR}
                  requestedAt={iso(72)}
                  expiresAt={inSeconds(21)}
                  canAcceptAs="accept"
                />
              }
            >
              <Skeleton withAction />
            </AppShell>
          </div>
        )}
      </Section>

      <Section name="Header">{() => <Header title={d02.title} onBack={() => undefined} />}</Section>

      <Section name="Card">
        {() => (
          <div className="pt-staterow">
            <State label="default">
              <Card>{VEHICLE}</Card>
            </State>
            <State label="elevated">
              <Card elevated>{VEHICLE}</Card>
            </State>
            <State label="dimmed">
              <Card dimmed>{VEHICLE}</Card>
            </State>
            <State label="danger">
              <Card tone="danger">{VEHICLE}</Card>
            </State>
          </div>
        )}
      </Section>

      <Section name="ListItem">
        {() => (
          <ul className="pt-list">
            <li>
              <ListItem
                icon={CarFront}
                title="#131"
                meta={`${vehicleMake.hyundai} سوناتا · أسود · B-07`}
                trailing={<StatusChip status="parked" size="sm" />}
                onClick={() => undefined}
              />
            </li>
            <li>
              <ListItem
                icon={CarFront}
                title="#128"
                trailing={<StatusChip status="requested" size="sm" />}
                onClick={() => undefined}
              />
            </li>
            <li>
              <ListItem
                icon={CarFront}
                title="#119"
                disabled
                trailing={<StatusChip status="delivered" size="sm" />}
                onClick={() => undefined}
              />
            </li>
          </ul>
        )}
      </Section>

      <Section name="TaskCard">
        {() => (
          <>
            <TaskCard
              ticketNumber={125}
              status="retrieving"
              vehicle={VEHICLE}
              plate={PLATE}
              car={CAR}
              stage="12"
              stageIcon={KeyRound}
              actionLabel={components.stepper.retrieve}
              onAction={() => undefined}
            />
            <TaskCard
              ticketNumber={131}
              next
              vehicle={VEHICLE}
              plate={PLATE}
              car={CAR}
              stage="0:42"
              stageIcon={Clock}
            />
          </>
        )}
      </Section>

      <Section name="OfferCard">
        {() => (
          <>
            <OfferCard
              offerId="a"
              mode="single"
              ticketNumber={125}
              vehicleSummary={VEHICLE}
              plate={PLATE}
              car={CAR}
              requestedAt={iso(72)}
              expiresAt={inSeconds(21)}
              canAcceptAs="accept"
            />
            <OfferCard
              offerId="b"
              mode="broadcast"
              ticketNumber={126}
              vehicleSummary={VEHICLE}
              requestedAt={iso(130)}
              canAcceptAs="reserve_next"
            />
            <OfferCard
              offerId="c"
              mode="broadcast"
              ticketNumber={127}
              vehicleSummary={VEHICLE}
              requestedAt={iso(40)}
              canAcceptAs="none"
            />
            <OfferCard
              offerId="d"
              mode="single"
              ticketNumber={128}
              vehicleSummary={VEHICLE}
              requestedAt={iso(20)}
              expiresAt={inSeconds(7)}
              canAcceptAs="accept"
              offline
            />
          </>
        )}
      </Section>

      <Section name="CountdownRing">
        {() => (
          <div className="pt-staterow">
            <CountdownRing seconds={21} />
            <CountdownRing seconds={7} />
          </div>
        )}
      </Section>

      <Section name="Stepper">
        {() => (
          <Stepper
            current={1}
            steps={[
              { label: components.stepper.key, time: '7:42 م' },
              { label: components.stepper.retrieve },
              { label: components.stepper.ready },
              { label: components.stepper.handover },
            ]}
            detail={
              <>
                <span>
                  <MapPin size={16} className="pt-icon" aria-hidden /> B-07
                </span>
              </>
            }
            actionLabel={components.stepper.ready}
            onAction={() => undefined}
          />
        )}
      </Section>

      <Section name="PlateInput">{() => <PlateInputDemo />}</Section>

      <Section name="LetterPad">
        {() => <LetterPad value={[['ب', 'B']]} onChange={() => undefined} />}
      </Section>

      <Section name="CarGlyph">
        {() => (
          <div className="pt-staterow">
            {(
              [
                ['sedan', 'white'],
                ['suv', 'black'],
                ['pickup', 'silver'],
                ['van', 'red'],
                ['sedan', 'blue'],
                ['suv', 'beige'],
                ['other', null],
              ] as const
            ).map(([type, color]) => (
              <CarGlyph key={`${type}-${color}`} type={type} color={color} width={72} />
            ))}
          </div>
        )}
      </Section>

      <Section name="PlateBadge">
        {() => (
          <div className="pt-staterow">
            <PlateBadge {...PLATE} />
            <PlateBadge {...PLATE} size="lg" />
          </div>
        )}
      </Section>

      <Section name="PhoneInput">
        {(theme) => (
          <>
            <PhoneInput
              id={`g-phone-${theme}`}
              label={d01.phoneLabel}
              placeholder={d01.phonePlaceholder}
              defaultValue="0551234567"
            />
            <PhoneInput
              id={`g-phone-err-${theme}`}
              label={d01.phoneLabel}
              defaultValue="0123"
              error={d01.phoneInvalid}
            />
          </>
        )}
      </Section>

      <Section name="MaskedPhone">{() => <MaskedPhone phone="+966551234123" />}</Section>

      <Section name="TextField">
        {(theme) => (
          <>
            <TextField
              id={`g-tf-${theme}`}
              label={d01.secretLabel}
              revealable
              defaultValue="123456"
              dir="ltr"
            />
            <TextField
              id={`g-tf-err-${theme}`}
              label={d02.current}
              defaultValue="99"
              error={d02.currentWrong}
              dir="ltr"
            />
            <TextField id={`g-tf-load-${theme}`} label={d02.next} loading defaultValue="K7Q2-9F" dir="ltr" />
            <TextField id={`g-tf-dis-${theme}`} label={d02.confirm} disabled defaultValue="—" />
          </>
        )}
      </Section>

      <Section name="TextArea">
        {(theme) => <TextArea id={`g-ta-${theme}`} label={components.dialog.reason} defaultValue="" />}
      </Section>

      <Section name="Select">
        {(theme) => (
          <Select
            id={`g-select-${theme}`}
            label={vehicleMake.other}
            options={Object.entries(vehicleMake).slice(0, 6) as [string, string][]}
          />
        )}
      </Section>

      <Section name="Checkbox">
        {(theme) => (
          <>
            <Checkbox id={`g-check-${theme}`} label={d03.testAudio} defaultChecked />
            <Checkbox id={`g-check-err-${theme}`} label={d03.testAudio} error={d02.weak} />
          </>
        )}
      </Section>

      <Section name="Radio">
        {(theme) => (
          <Radio
            name={`g-radio-${theme}`}
            legend={components.money.currency}
            options={[
              ['cash', 'نقدًا'],
              ['pos', 'شبكة (نقاط بيع)'],
            ]}
            value={s.radio}
            onChange={s.setRadio}
          />
        )}
      </Section>

      <Section name="Toggle">
        {(theme) => (
          <Toggle id={`g-toggle-${theme}`} label={d15.audio} checked={s.toggle} onChange={s.setToggle} />
        )}
      </Section>

      <Section name="SegmentedControl">
        {() => (
          <SegmentedControl
            label={d14.appearance}
            value={s.seg}
            onChange={s.setSeg}
            options={[
              { value: 'system', label: d14.themeSystem },
              { value: 'light', label: d14.themeLight },
              { value: 'dark', label: d14.themeDark },
            ]}
          />
        )}
      </Section>

      <Section name="SearchField">
        {() => <SearchField value={s.search} onChange={s.setSearch} inputMode="numeric" />}
      </Section>

      <Section name="FilterChips">
        {() => (
          <FilterChips
            value={s.filters}
            onChange={s.setFilters}
            options={[
              { value: 'requested', label: ticketStatus.requested, count: 4 },
              { value: 'parked', label: ticketStatus.parked, count: 28 },
              { value: 'ready', label: ticketStatus.ready, count: 1 },
              { value: 'voided', label: ticketStatus.voided, disabled: true },
            ]}
          />
        )}
      </Section>

      <Section name="ColorChips">
        {() => <ColorChips value={s.color} onChange={(v) => s.setColor(v as 'white')} />}
      </Section>

      <Section name="CodeInput">
        {(theme) => (
          <>
            <CodeInput id={`g-code-${theme}`} value={s.code} onChange={s.setCode} attemptsLeft={2} />
            <CodeInput id={`g-code-l-${theme}`} value="" onChange={() => undefined} locked />
          </>
        )}
      </Section>

      <Section name="SpotGrid">
        {() => (
          <SpotGrid
            spots={['A-01', 'A-02', 'A-03', 'A-04', 'A-05', 'A-06', 'B-01', 'B-02'].map((code, i) => ({
              code,
              occupied: i % 3 === 0,
            }))}
            selected={s.spot}
            onSelect={s.setSpot}
            allowNote
          />
        )}
      </Section>

      <Section name="PhotoGrid">
        {() => (
          <PhotoGrid
            tiles={[
              { angle: mediaKind.photo_front, state: 'uploaded' },
              { angle: mediaKind.photo_rear, state: 'uploading', progress: 60 },
              { angle: mediaKind.photo_right, state: 'failed' },
              { angle: mediaKind.photo_left },
            ]}
          />
        )}
      </Section>

      <Section name="QrPanel">{() => <QrPanel qrSvg={qrSvg} ttl="4:12" />}</Section>

      <Section name="Banner">
        {() => (
          <>
            <Banner
              kind="offline"
              message={fmt(d15.offline, { time: '7:42 م' })}
              detail={d15.offlineDetail}
              actionLabel={components.photo.retry}
              onAction={() => undefined}
            />
            <Banner kind="stale" />
            <Banner kind="audio" onAction={() => undefined} loading />
            <Banner kind="whatsapp" />
            <Banner kind="notifications" />
            <Banner kind="update" onAction={() => undefined} />
          </>
        )}
      </Section>

      <Section name="Toast">
        {() => (
          <div className="pt-staterow">
            <Toast message={d02.submit} tone="success" />
            <Toast message={d01.offline} tone="error" />
            <Toast message={d15.updateNow} tone="info" />
          </div>
        )}
      </Section>

      <Section name="Dialog">
        {() => (
          <Dialog
            inline
            open
            title={d14.endShiftConfirm}
            destructive
            confirmLabel={d14.endShift}
            onConfirm={() => undefined}
            onCancel={() => undefined}
            reasonRequired
            reason=""
          />
        )}
      </Section>

      <Section name="Sheet">
        {() => (
          <Sheet inline open onOpenChange={() => undefined} title={components.spot.choose}>
            <p className="m-0">{fmt(components.offer.waitingSince, { time: '2:10' })}</p>
          </Sheet>
        )}
      </Section>

      <Section name="EmptyState">
        {() => (
          <EmptyState
            icon={BellRing}
            title={d04.emptyTitle}
            body={d04.emptyBody}
            actionLabel={components.photo.retry}
            onAction={() => undefined}
          />
        )}
      </Section>

      <Section name="Skeleton">
        {() => (
          <>
            <Skeleton withAction />
            <Skeleton variant="line" width="60%" />
          </>
        )}
      </Section>

      <Section name="KpiTile">
        {() => (
          <div className="pt-staterow">
            <KpiTile label={ticketStatus.requested} value={7} icon={BellRing} />
            <KpiTile label={components.queue.waiting} value="6:40" icon={Clock} tone="warning" />
            <KpiTile label={alertType.wa_send_failed} value={2} icon={TriangleAlert} tone="danger" loading />
          </div>
        )}
      </Section>

      <Section name="KpiStrip">
        {() => (
          <KpiStrip
            items={[
              { label: ticketStatus.requested, value: 7, icon: BellRing },
              { label: components.queue.waiting, value: '6:40', icon: Clock, tone: 'warning' },
              { label: components.driverRow.current, value: '5 / 3', icon: Users, tone: 'success' },
            ]}
          />
        )}
      </Section>

      <Section name="QueueItem">
        {() => (
          <>
            <QueueItem
              ticketNumber={125}
              vehicle={VEHICLE}
              plate={PLATE}
              waiting="6:40"
              escalations={[{ level: 'warning', label: alertType.request_unaccepted }]}
            />
            <QueueItem
              ticketNumber={126}
              status="assigned"
              vehicle={VEHICLE}
              waiting="12:05"
              assignee="سعد"
              critical
              changed
              escalations={[{ level: 'critical', label: alertType.next_task_waiting_long }]}
            />
          </>
        )}
      </Section>

      <Section name="TaskRow">
        {() => (
          <div className="pt-taskrow-scroll">
            <TaskRow
              ticketNumber={125}
              status="retrieving"
              driver="سعد الحربي"
              stage={components.stepper.retrieve}
              elapsed="4:10"
            />
            <TaskRow
              ticketNumber={131}
              status="assigned_waiting"
              stage={components.task.nextBadge}
              elapsed="0:42"
            />
          </div>
        )}
      </Section>

      <Section name="DriverRow">
        {() => (
          <DriverRow
            name="سعد الحربي"
            state="busy_with_next"
            connection="uncertain"
            lastSync="23:04"
            current={125}
            next={131}
            custody={2}
          />
        )}
      </Section>

      <Section name="AlertItem">
        {() => (
          <>
            <AlertItem
              severity="critical"
              title="#125"
              type={alertType.request_unaccepted}
              time="7:42 م"
              onAck={() => undefined}
              onResolve={() => undefined}
            />
            <AlertItem
              severity="warning"
              title="#131"
              type={alertType.next_task_waiting_long}
              time="7:40 م"
              acknowledged
              onResolve={() => undefined}
            />
            <AlertItem
              severity="info"
              title="#119"
              type={alertType.inspection_incomplete}
              time="7:31 م"
              loading="ack"
              onAck={() => undefined}
              onResolve={() => undefined}
            />
          </>
        )}
      </Section>

      <Section name="Timeline">
        {() => (
          <Timeline
            events={[
              { kind: 'ticket', text: ticketStatus.requested, actor: 'سعد', time: '7:42 م' },
              { kind: 'custody', text: components.stepper.key, actor: 'سعد', time: '7:44 م' },
              {
                kind: 'whatsapp',
                text: ticketStatus.ready,
                actor: '—',
                time: '7:50 م',
                message: '••••••',
                failed: true,
              },
            ]}
          />
        )}
      </Section>

      <Section name="DataTable">
        {() => (
          <DataTable
            layout="auto"
            rowKey={(r: { n: number; status: TicketStatus; driver: string }) => String(r.n)}
            columns={[
              { key: 'n', label: '#' },
              {
                key: 'status',
                label: ticketStatus.requested,
                render: (r) => <StatusChip status={r.status} size="sm" />,
              },
              { key: 'driver', label: components.driverRow.current, sortable: true },
            ]}
            rows={[
              { n: 125, status: 'retrieving', driver: 'سعد' },
              { n: 126, status: 'requested', driver: '—' },
            ]}
            sort={{ key: 'driver', dir: 'asc' }}
            hasNext
          />
        )}
      </Section>
    </div>
  );
}

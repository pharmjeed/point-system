/**
 * Foreground/background token pairs the components actually use (03 §5, BRAND §4.2), checked in both
 * themes by test/contrast.test.ts against WCAG 2.2 AA: 4.5:1 for text, 3:1 for graphics/borders/focus.
 * Names are --pt-* roles without the prefix. Disabled text (`text-disabled`) is exempt (WCAG 1.4.3) and
 * the 8px connection dots are decorative next to their text, so neither is listed.
 * Add a pair here whenever a component starts using a new combination.
 */
export interface ContrastPair {
  fg: string;
  bg: string;
  min: 3 | 4.5;
  usage: string;
}

const TEXT = 4.5 as const;
const GRAPHIC = 3 as const;

const TICKET_STATUSES = [
  'received',
  'parking',
  'parked',
  'requested',
  'assigned',
  'assigned-waiting',
  'retrieving',
  'ready',
  'delivered',
  'reparking',
  'voided',
];
const DRIVER_STATES = ['available', 'intake-parking', 'retrieving', 'busy-with-next', 'on-break', 'off-duty'];

export const CONTRAST_PAIRS: ContrastPair[] = [
  // body text and secondary text on every surface
  ...['bg', 'surface', 'surface-2'].flatMap((bg) => [
    { fg: 'text', bg, min: TEXT, usage: 'primary text' },
    { fg: 'text-muted', bg, min: TEXT, usage: 'secondary text, hints, placeholders' },
  ]),
  { fg: 'text', bg: 'primary-subtle', min: TEXT, usage: 'SideNav active item, FilterChips on' },
  { fg: 'text', bg: 'info-subtle', min: TEXT, usage: 'Banner info, AlertItem info' },
  // primary actions and links
  { fg: 'on-primary', bg: 'primary', min: TEXT, usage: 'Button primary, current Stepper mark' },
  { fg: 'on-primary', bg: 'primary-hover', min: TEXT, usage: 'Button primary :hover' },
  { fg: 'on-primary', bg: 'primary-pressed', min: TEXT, usage: 'Button primary pressed / «جارٍ…»' },
  { fg: 'primary-text', bg: 'surface', min: TEXT, usage: 'links, ghost button, «إظهار»' },
  { fg: 'primary-text', bg: 'bg', min: TEXT, usage: 'links on the page background, BottomNav active' },
  { fg: 'primary-text', bg: 'primary-subtle', min: TEXT, usage: 'ghost button pressed' },
  // other variants (DEC-49e)
  { fg: 'text-inverse', bg: 'danger', min: TEXT, usage: 'Button danger, badges' },
  { fg: 'status-ready-fg', bg: 'status-ready-bg', min: TEXT, usage: 'Button success, Stepper done' },
  { fg: 'driver-busy-with-next-fg', bg: 'driver-busy-with-next-bg', min: TEXT, usage: 'Button reserve' },
  { fg: 'text-inverse', bg: 'surface-inverse', min: TEXT, usage: 'Toast' },
  // feedback text
  ...['surface', 'bg', 'danger-subtle'].map((bg) => ({
    fg: 'danger-text',
    bg,
    min: TEXT,
    usage: 'field errors, Banner danger',
  })),
  ...['surface', 'bg', 'surface-2', 'warning-subtle'].map((bg) => ({
    fg: 'warning-text',
    bg,
    min: TEXT,
    usage: 'ConnectionIndicator uncertain, Banner warning, escalations',
  })),
  ...['surface', 'bg', 'success-subtle'].map((bg) => ({
    fg: 'success-text',
    bg,
    min: TEXT,
    usage: 'ConnectionIndicator online, Timeline whatsapp',
  })),
  { fg: 'info-text', bg: 'info-subtle', min: TEXT, usage: 'Banner info action' },
  { fg: 'on-warning', bg: 'warning', min: TEXT, usage: 'warning fill' },
  // status and driver chips (StatusChip, DriverStateChip, SideNav count)
  ...TICKET_STATUSES.map((s) => ({
    fg: `status-${s}-fg`,
    bg: `status-${s}-bg`,
    min: TEXT,
    usage: `StatusChip ${s}`,
  })),
  ...DRIVER_STATES.map((s) => ({
    fg: `driver-${s}-fg`,
    bg: `driver-${s}-bg`,
    min: TEXT,
    usage: `DriverStateChip ${s}`,
  })),
  // graphics: field and secondary-button borders, focus ring, error borders (DEC-50)
  ...['surface', 'bg', 'surface-2'].map((bg) => ({
    fg: 'border-strong',
    bg,
    min: GRAPHIC,
    usage: 'field / secondary button border',
  })),
  ...['surface', 'bg'].map((bg) => ({ fg: 'focus', bg, min: GRAPHIC, usage: 'focus ring' })),
  {
    fg: 'primary',
    bg: 'surface',
    min: GRAPHIC,
    usage: 'focused field border, selected spot, OfferCard frame',
  },
  { fg: 'danger', bg: 'surface', min: GRAPHIC, usage: 'error border, critical AlertItem frame' },
  { fg: 'text-muted', bg: 'surface', min: GRAPHIC, usage: 'Checkbox / Radio / Toggle outline' },
];

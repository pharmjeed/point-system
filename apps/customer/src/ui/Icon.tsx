/**
 * Icons of the customer app (V2-UX, DEC-573): Lucide (brand §6, 03 §2.6) through `lucide-react-native` on
 * `react-native-svg`, stroke 2, 24 by default (20 inside buttons). Each icon is imported from its own file so only
 * the icons below are bundled. Icons are decoration next to a text that says the same thing: hidden from screen
 * readers. Directional icons (back, «go» chevrons) are mirrored in RTL (03 §2.6, DEC-85); the others never are.
 */
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import ArrowUp from 'lucide-react-native/icons/arrow-up';
import BadgePercent from 'lucide-react-native/icons/badge-percent';
import BellRing from 'lucide-react-native/icons/bell-ring';
import Bookmark from 'lucide-react-native/icons/bookmark';
import Building2 from 'lucide-react-native/icons/building-2';
import CalendarCheck from 'lucide-react-native/icons/calendar-check';
import CalendarDays from 'lucide-react-native/icons/calendar-days';
import Car from 'lucide-react-native/icons/car';
import CarFront from 'lucide-react-native/icons/car-front';
import Check from 'lucide-react-native/icons/check';
import CheckCheck from 'lucide-react-native/icons/check-check';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import CircleParking from 'lucide-react-native/icons/circle-parking';
import CircleX from 'lucide-react-native/icons/circle-x';
import Clock from 'lucide-react-native/icons/clock';
import CreditCard from 'lucide-react-native/icons/credit-card';
import Eye from 'lucide-react-native/icons/eye';
import EyeOff from 'lucide-react-native/icons/eye-off';
import FileText from 'lucide-react-native/icons/file-text';
import GraduationCap from 'lucide-react-native/icons/graduation-cap';
import Globe from 'lucide-react-native/icons/globe';
import History from 'lucide-react-native/icons/history';
import Info from 'lucide-react-native/icons/info';
import KeyRound from 'lucide-react-native/icons/key-round';
import ListOrdered from 'lucide-react-native/icons/list-ordered';
import LogOut from 'lucide-react-native/icons/log-out';
import MapIcon from 'lucide-react-native/icons/map';
import MapPin from 'lucide-react-native/icons/map-pin';
import MessageCircle from 'lucide-react-native/icons/message-circle';
import MessageSquareWarning from 'lucide-react-native/icons/message-square-warning';
import Navigation from 'lucide-react-native/icons/navigation';
import Plus from 'lucide-react-native/icons/plus';
import QrCode from 'lucide-react-native/icons/qr-code';
import Receipt from 'lucide-react-native/icons/receipt';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import RotateCcw from 'lucide-react-native/icons/rotate-ccw';
import ScrollText from 'lucide-react-native/icons/scroll-text';
import Search from 'lucide-react-native/icons/search';
import Settings from 'lucide-react-native/icons/settings';
import ShieldCheck from 'lucide-react-native/icons/shield-check';
import Smartphone from 'lucide-react-native/icons/smartphone';
import Snowflake from 'lucide-react-native/icons/snowflake';
import SquareParking from 'lucide-react-native/icons/square-parking';
import Star from 'lucide-react-native/icons/star';
import Sun from 'lucide-react-native/icons/sun';
import Timer from 'lucide-react-native/icons/timer';
import Trash2 from 'lucide-react-native/icons/trash-2';
import TriangleAlert from 'lucide-react-native/icons/triangle-alert';
import User from 'lucide-react-native/icons/user';
import UserCheck from 'lucide-react-native/icons/user-check';
import Wallet from 'lucide-react-native/icons/wallet';
import { View } from 'react-native';
import { color } from '../theme/tokens';
import { isRTL } from './direction';

const ICONS = {
  back: ArrowLeft,
  'arrow-up': ArrowUp,
  'badge-percent': BadgePercent,
  'bell-ring': BellRing,
  bookmark: Bookmark,
  building: Building2,
  'calendar-check': CalendarCheck,
  // V2-036 (DEC-605): the counted days, the student plan, the freeze, the complaints
  'calendar-days': CalendarDays,
  'graduation-cap': GraduationCap,
  snowflake: Snowflake,
  'message-warning': MessageSquareWarning,
  car: Car,
  'car-front': CarFront,
  check: Check,
  'check-check': CheckCheck,
  go: ChevronRight,
  'circle-alert': CircleAlert,
  'circle-check': CircleCheck,
  'circle-parking': CircleParking,
  'circle-x': CircleX,
  clock: Clock,
  'credit-card': CreditCard,
  eye: Eye,
  'eye-off': EyeOff,
  'file-text': FileText,
  globe: Globe,
  history: History,
  info: Info,
  key: KeyRound,
  'list-ordered': ListOrdered,
  'log-out': LogOut,
  map: MapIcon,
  'map-pin': MapPin,
  'message-circle': MessageCircle,
  navigation: Navigation,
  plus: Plus,
  'qr-code': QrCode,
  receipt: Receipt,
  refresh: RefreshCw,
  'rotate-ccw': RotateCcw,
  'scroll-text': ScrollText,
  search: Search,
  settings: Settings,
  'shield-check': ShieldCheck,
  smartphone: Smartphone,
  'square-parking': SquareParking,
  star: Star,
  sun: Sun,
  timer: Timer,
  trash: Trash2,
  'triangle-alert': TriangleAlert,
  user: User,
  'user-check': UserCheck,
  wallet: Wallet,
} as const;

export type IconName = keyof typeof ICONS;

/** Written left to right and mirrored in RTL: «back» points to the start of the line, «go» to its end (DEC-85). */
const DIRECTIONAL: ReadonlySet<IconName> = new Set<IconName>(['back', 'go']);

export function Icon({
  name,
  size = 24,
  tint = color.text,
  strokeWidth = 2,
  fill,
}: {
  name: IconName;
  size?: number;
  tint?: string;
  strokeWidth?: number;
  /** a filled glyph (the stars of C-13) */
  fill?: string;
}) {
  const Glyph = ICONS[name];
  const mirror = DIRECTIONAL.has(name) && isRTL();
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      aria-hidden
      pointerEvents="none"
      style={[{ width: size, height: size }, mirror && { transform: [{ scaleX: -1 }] }]}
    >
      <Glyph size={size} color={tint} strokeWidth={strokeWidth} {...(fill ? { fill } : {})} />
    </View>
  );
}

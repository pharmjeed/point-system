import { Archive, History, MessageCircle, ScrollText, Settings, ShieldCheck, Users } from 'lucide-react';
import { useNavigate, useParams } from 'react-router';
import { paths } from '@/app/paths';
import { Header, ListItem } from '@/components';
import { useStaffMe } from '@/features/ops/StaffLayout';
import { adminSectionsFor, can, type AdminSection } from '@/features/supervisor/permissions';
import { staffPaths } from '@/features/supervisor/staffPaths';
import { ForbiddenPage, ForbiddenState, NotFoundState } from '@/features/supervisor/ui';
import { s13 } from '@/i18n/ar';
import { AuditLogSection } from './AuditLogSection';
import { OrgSettingsSection } from './OrgSettingsSection';
import { OutboxSection } from './OutboxSection';
import { RetentionSection } from './RetentionSection';
import { ChannelSection, TemplatesSection } from './WhatsAppSections';
import '@/features/supervisor/staff.css';

const ICONS: Record<AdminSection, typeof History> = {
  channel: MessageCircle,
  templates: ScrollText,
  outbox: Archive,
  audit: History,
  retention: ShieldCheck,
  org: Settings,
};

/**
 * S-13 — الإدارة (02 §4 S-13, PNT-091/092): the sections this account may open (02 §2.2 table, 09 §3),
 * each at `/admin/:section`. «الموظفون» (`staff.manage`) belongs to another ticket and is listed as not built.
 */
export function AdminPage() {
  const me = useStaffMe();
  const sections = adminSectionsFor(me);
  const staffManage = can(me, 'staff.manage');
  if (!sections.length && !staffManage) return <ForbiddenPage title={s13.title} />;
  return (
    <section className="st-page" aria-labelledby="admin-title">
      <h1 className="pt-page-title" id="admin-title">
        {s13.title}
      </h1>
      <ul className="pt-list">
        {staffManage ? (
          <li>
            <ListItem icon={Users} title={s13.sections.staff} meta={s13.notBuilt} />
          </li>
        ) : null}
        {sections.map((id) => (
          <li key={id}>
            <ListItem icon={ICONS[id]} title={s13.sections[id]} to={staffPaths.adminSection(id)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AdminSectionPage() {
  const me = useStaffMe();
  const navigate = useNavigate();
  const { section = '' } = useParams();
  const allowed = adminSectionsFor(me);
  const known = (Object.keys(ICONS) as AdminSection[]).includes(section as AdminSection);
  const id = section as AdminSection;
  const back = () => navigate(paths.admin);
  if (!known)
    return (
      <div className="st-page">
        <Header title={s13.title} onBack={back} />
        <NotFoundState backTo={paths.admin} />
      </div>
    );
  return (
    <div className="st-page">
      <Header title={s13.sections[id]} onBack={back} />
      {!allowed.includes(id) ? (
        <ForbiddenState backTo={paths.admin} />
      ) : id === 'audit' ? (
        <AuditLogSection />
      ) : id === 'outbox' ? (
        <OutboxSection me={me} />
      ) : id === 'channel' ? (
        <ChannelSection me={me} />
      ) : id === 'templates' ? (
        <TemplatesSection me={me} />
      ) : id === 'retention' ? (
        <RetentionSection me={me} />
      ) : (
        <OrgSettingsSection />
      )}
    </div>
  );
}

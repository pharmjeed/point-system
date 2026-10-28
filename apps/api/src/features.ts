import type { Type } from '@nestjs/common';

// Domain HTTP modules registered by the api process. Each module owns one import line and one push line;
// the blank lines between them keep parallel merges conflict-free.

export const FEATURE_MODULES: Type[] = [];

import { IdentityAccessHttpModule } from '@point/server';
FEATURE_MODULES.push(IdentityAccessHttpModule);

import { VenuesEventsHttpModule } from '@point/server';
FEATURE_MODULES.push(VenuesEventsHttpModule);

// import { TicketsCustodyHttpModule } from '@point/server';
// FEATURE_MODULES.push(TicketsCustodyHttpModule);

// import { DispatchHttpModule } from '@point/server';
// FEATURE_MODULES.push(DispatchHttpModule);

// import { WhatsappHttpModule } from '@point/server';
// FEATURE_MODULES.push(WhatsappHttpModule);

// import { NotificationsHttpModule } from '@point/server';
// FEATURE_MODULES.push(NotificationsHttpModule);

// import { IncidentsHttpModule } from '@point/server';
// FEATURE_MODULES.push(IncidentsHttpModule);

// import { PaymentsReportsHttpModule } from '@point/server';
// FEATURE_MODULES.push(PaymentsReportsHttpModule);

// import { AuditMonitoringHttpModule } from '@point/server';
// FEATURE_MODULES.push(AuditMonitoringHttpModule);

import { MediaHttpModule } from '@point/server';
FEATURE_MODULES.push(MediaHttpModule);

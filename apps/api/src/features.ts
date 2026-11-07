import type { Type } from '@nestjs/common';

// Domain HTTP modules registered by the api process. Each module owns one import line and one push line;
// the blank lines between them keep parallel merges conflict-free.

export const FEATURE_MODULES: Type[] = [];

import { IdentityAccessHttpModule } from '@point/server';
FEATURE_MODULES.push(IdentityAccessHttpModule);

import { VenuesEventsHttpModule } from '@point/server';
FEATURE_MODULES.push(VenuesEventsHttpModule);

import { TicketsCustodyHttpModule } from '@point/server';
FEATURE_MODULES.push(TicketsCustodyHttpModule);

import { DispatchHttpModule } from '@point/server';
FEATURE_MODULES.push(DispatchHttpModule);

import { WhatsappHttpModule } from '@point/server';
FEATURE_MODULES.push(WhatsappHttpModule);

import { CustomerFlowsHttpModule } from '@point/server';
FEATURE_MODULES.push(CustomerFlowsHttpModule);

import { NotificationsHttpModule } from '@point/server';
FEATURE_MODULES.push(NotificationsHttpModule);

import { IncidentsHttpModule } from '@point/server';
FEATURE_MODULES.push(IncidentsHttpModule);

import { PaymentsReportsHttpModule } from '@point/server';
FEATURE_MODULES.push(PaymentsReportsHttpModule);
import { EventCloseHttpModule } from '@point/server';
FEATURE_MODULES.push(EventCloseHttpModule);

import { AuditMonitoringHttpModule } from '@point/server';
FEATURE_MODULES.push(AuditMonitoringHttpModule);

import { MediaHttpModule } from '@point/server';
FEATURE_MODULES.push(MediaHttpModule);

import { SupervisorHttpModule } from '@point/server';
FEATURE_MODULES.push(SupervisorHttpModule);

import { PlatformHttpModule } from '@point/server';
FEATURE_MODULES.push(PlatformHttpModule);

import { VenueProfilesHttpModule } from '@point/server';
FEATURE_MODULES.push(VenueProfilesHttpModule);

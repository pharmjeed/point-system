/**
 * «Terms and Conditions» — the English text (C-24; DEC-614 … DEC-618), clause for clause the Arabic one
 * (`terms.ar.ts`, which prevails): the same sections, ids and clause count (a test checks it).
 *
 * ⚠ LEGAL REVIEW: a draft written from the subscriptions annex; it must be reviewed by a lawyer before the app is
 * published or the text is put on the website (DEC-615). Never show this note to customers.
 *
 * Changing the text bumps `SUBSCRIPTION_TERMS_VERSION` in `@point/shared/customer` and regenerates
 * `docs/v2/store/TERMS_EN.md` (`TERMS_DOCS_WRITE=1 pnpm --filter @point/customer test`).
 */
import { SUBSCRIPTION_TERMS_VERSION } from '@point/shared/customer';
import type { TermsDocument } from './terms';

export const termsEn: TermsDocument = {
  locale: 'en',
  version: SUBSCRIPTION_TERMS_VERSION,
  updatedAt: '2026-11-17',
  title: 'Terms and Conditions',
  updated: 'Last updated: {date} · Version {version}',
  intro:
    'These terms govern your use of the {brand} app, the valet parking service and its subscriptions. By using the app or subscribing to a plan, you accept them.',
  contents: 'Contents',
  generic: {
    serviceDays: 'the number of service days set by the plan (22 service days on the Student plan)',
    serviceWeek: 'on the weekdays set by the plan (Sunday to Thursday on the Student plan)',
    offDays: 'the other days of the week (Friday and Saturday on the Student plan)',
    price: 'the price shown for the plan before VAT, per term (SAR 150 on the Student plan)',
    dailyLimit: 'the number of daily visits set by the plan (one visit a day on the Student plan)',
    freezeLimit:
      'as often and for as long as the plan allows (once per term, for up to 5 service days, on the Student plan)',
    freezeDays: 'the freeze limit (5 service days on the Student plan)',
  },
  sections: [
    {
      id: 'definitions',
      title: 'Definitions',
      clauses: [
        '“{brand}”, “we” or “us”: the provider of the service through the app, and whoever operates it on its behalf at the locations.',
        '“App”: the {brand} customer app.',
        '“You” or “subscriber”: the holder of an account in the app, and the person a subscription is activated for.',
        '“Service”: receiving, parking, retrieving and handing over the vehicle at the location.',
        '“Location”: a place where the service is provided, as shown in the app.',
        '“Host”: the body whose premises the location is on, such as a university.',
        '“Plan”: a subscription offer with a price, a term and rules shown before payment.',
        '“Term”: one paid subscription period.',
        '“Service day”: a day that counts towards the term under the plan.',
        '“Freeze”: a pause of the service and of the day count at your request.',
      ],
    },
    {
      id: 'service',
      title: 'The service and its scope',
      clauses: [
        'We provide the service at the locations shown in the app, only on the working days and hours announced for each location.',
        'The service covers receiving, parking, retrieving and handing over the vehicle. It does not include an inventory or separate safekeeping of its contents.',
        'Every subscription is governed by these terms and by the plan rules shown before payment.',
      ],
    },
    {
      id: 'account',
      title: 'Account and eligibility',
      clauses: [
        'Some plans are for a specific group, such as the students of a host; the eligible group is shown on the plan.',
        'A subscription to such a plan is activated once your eligibility is confirmed and the payment succeeds; we may ask for your student number and your name as on your card.',
        'A subscription is personal and cannot be shared.',
      ],
    },
    {
      id: 'pricing',
      title: 'Plans, prices and VAT',
      clauses: [
        'You pay for a subscription directly to {brand} in the app.',
        'The host is not obliged to pay for a subscription or to guarantee its collection.',
        'Subscription price: {price}.',
        'VAT due by law is added; its amount and the total are shown before payment.',
        'An invoice is issued for every payment, and we keep a record of your acceptance of the terms and the price.',
        'Any price change is announced before renewal and never applies to a period already paid.',
      ],
    },
    {
      id: 'term',
      title: 'Term and service days',
      clauses: [
        'A term is {serviceDays}, counted {serviceWeek} from the activation date.',
        '“Monthly” in a plan name means the term and its service days, not a calendar month or 30 days.',
        '{offDays} do not count. All other service days count, even on an academic or public holiday, unless a freeze under section {§freeze} covers them.',
        'Scheduled holidays are shown in the app before payment. They do not extend the plan automatically, and you may freeze during them.',
        'A service day you do not attend or use is not carried over.',
        'The app shows the start and end dates of your subscription and the service days left.',
      ],
    },
    {
      id: 'daily-use',
      title: 'Daily use and vehicles',
      clauses: [
        'The plan includes {dailyLimit}; a visit covers receiving, parking, retrieving and handing over the vehicle.',
        'The service covers one vehicle per visit; you can update the registered vehicle before it is received.',
        'Future use of the subscription stops when the plan ends or is not paid, without holding your vehicle, its key or your belongings.',
      ],
    },
    {
      id: 'renewal',
      title: 'Activation and renewal',
      clauses: [
        'A subscription is activated once your eligibility is confirmed, where the plan requires it, and the payment succeeds.',
        'Renewal is optional and happens at your request after the plan ends.',
        'We never charge a renewal automatically without your separate, explicit consent.',
        'We stop selling new subscriptions once a location reaches its approved capacity, so that subscribers are served.',
      ],
    },
    {
      id: 'freeze',
      title: 'Freeze',
      clauses: [
        'You may freeze your subscription {freezeLimit}.',
        'Request a freeze in advance in the app, with a start date and a return date. A freeze never applies retroactively.',
        'The service and the day count stop during a freeze. The remaining days resume when it ends or when you reactivate early.',
        'The end date of your subscription moves by the days actually frozen.',
        '{offDays} do not count towards {freezeDays} and are not compensated.',
        'Once used, the freeze for that term is spent, even if it was shorter than the maximum.',
      ],
    },
    {
      id: 'refunds',
      title: 'Cancellation and refunds',
      clauses: [
        'Subscription fees are not refundable once paid if you change your mind, ask to cancel or do not use the service, before or after activation. Your right to freeze under section {§freeze} remains.',
        'The no-refund condition is shown clearly before payment, and your acceptance is recorded.',
        'This condition does not affect your statutory rights, or the settlement of periods not delivered when the service agreement for the location ends under its terms.',
        'In the cases excepted from the no-refund condition, the settlement is documented, and the remaining service days due are refunded in proportion to {serviceDays} of the plan price paid, with VAT settled by law.',
        'The amount is returned to the original payment method, or a documented alternative, within 12 calendar days of the date the refund becomes due, and never later than any shorter statutory period.',
      ],
    },
    {
      id: 'closures',
      title: 'Location closures and holidays',
      clauses: [
        'A location may close temporarily for reasons beyond the control of {brand}, including decisions of the host or the authorities, maintenance and emergencies.',
        '{brand} is not liable to compensate for the closure decision itself unless it results from its own fault or negligence.',
        'The term keeps counting during a closure, without a refund or an automatic extension because of it, and your right to freeze under section {§freeze} remains, as far as the law allows.',
        'We tell you about a closure as soon as we know of it.',
        'This section does not apply where the law requires a settlement because the service cannot be provided, or when the service agreement for the location ends, and it does not release {brand} from liability for its own fault or negligence.',
      ],
    },
    {
      id: 'belongings',
      title: 'Belongings and liability',
      clauses: [
        'Before you subscribe and before each handover we remind you to take your personal and valuable belongings out of the vehicle: the service does not include an inventory or separate safekeeping of them.',
        'This does not affect the liability of {brand} for the loss of or damage to belongings when the damage is proven to result from its fault or negligence, or from the acts of its staff while it holds the vehicle, under Saudi law.',
      ],
    },
    {
      id: 'complaints',
      title: 'Complaints and contact',
      clauses: [
        'Payments, freeze requests and complaints are made in the app.',
        'Every complaint is registered with a reference number shown to you in the app, and handled under the approved operating procedures.',
      ],
    },
    {
      id: 'privacy',
      title: 'Privacy',
      clauses: [
        'We process your personal data under the privacy policy published in the app.',
        'The terms and the privacy policy are shown before payment and your acceptance is recorded; accepting them does not waive any of your statutory rights.',
      ],
    },
    {
      id: 'changes',
      title: 'Changes to these terms',
      clauses: [
        'We may update these terms; the date of the last update and the version are shown at the top.',
        'We ask you to accept an updated version before your next payment, and an update never applies to a period already paid.',
      ],
    },
    {
      id: 'law',
      title: 'Governing law',
      clauses: [
        'These terms are governed by and construed under the laws of the Kingdom of Saudi Arabia.',
        'The competent courts of the Kingdom of Saudi Arabia have jurisdiction over any dispute arising from them.',
        'If the Arabic and English texts differ, the Arabic text prevails.',
      ],
    },
  ],
};

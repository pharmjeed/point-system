import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { components } from '@/i18n/ar';
import { Button, type ButtonVariant } from './Button';
import { Icon } from './Icon';

export interface StepperStep {
  label: string;
  /** Formatted completion time («7:42 م»). */
  time?: string;
}

export interface StepperProps {
  current: 0 | 1 | 2 | 3;
  steps?: StepperStep[];
  /** Key board/slot or spot/zone of the current step — for the assignee only (03 §3.6). */
  detail?: ReactNode;
  actionLabel?: string;
  actionVariant?: ButtonVariant;
  onAction?: () => Promise<unknown> | void;
  loading?: boolean;
  disabled?: boolean;
  error?: string;
}

const DEFAULT_STEPS: StepperStep[] = [
  { label: components.stepper.key },
  { label: components.stepper.retrieve },
  { label: components.stepper.ready },
  { label: components.stepper.handover },
];

/** The four retrieval steps of D-10; only the current step has a button, done steps show a check and time. */
export function Stepper({
  current,
  steps = DEFAULT_STEPS,
  detail,
  actionLabel,
  actionVariant,
  onAction,
  loading,
  disabled,
  error,
}: StepperProps) {
  return (
    <ol className="pt-stepper">
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'current' : 'todo';
        return (
          <li
            key={step.label}
            className={`pt-step pt-step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="pt-step__mark" aria-hidden="true">
              {state === 'done' ? <Icon icon={Check} size={16} /> : i + 1}
            </span>
            <div className="pt-step__body">
              <div className="pt-step__row">
                <span className="pt-step__label">{step.label}</span>
                {state === 'done' && step.time ? (
                  <bdi dir="ltr" className="pt-step__time">
                    {step.time}
                  </bdi>
                ) : null}
              </div>
              {state === 'current' && detail ? <div className="pt-step__detail">{detail}</div> : null}
              {state === 'current' && actionLabel ? (
                <Button
                  variant={actionVariant}
                  size="lg"
                  loading={loading}
                  disabled={disabled}
                  error={error}
                  onClick={onAction}
                >
                  {actionLabel}
                </Button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

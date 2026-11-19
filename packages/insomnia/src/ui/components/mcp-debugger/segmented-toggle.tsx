import React from 'react';
import { Button } from 'react-aria-components';

/** The small two-way toggle used in the trace header (Calls | Stream) and the params header (JSON | Form). */
export const SegmentedToggle = <T extends string>({
  label,
  options,
  value,
  onChange,
  testIdPrefix,
}: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  testIdPrefix: string;
}) => (
  <div
    className="flex shrink-0 overflow-hidden rounded-xs border border-solid border-(--hl-md)"
    role="group"
    aria-label={label}
  >
    {options.map(option => (
      <Button
        key={option.id}
        aria-pressed={value === option.id}
        onPress={() => onChange(option.id)}
        data-testid={`${testIdPrefix}-${option.id}`}
        className={`px-2 py-0.5 text-xs ${value === option.id ? 'bg-(--hl-sm) text-(--color-font)' : 'text-(--hl) hover:bg-(--hl-xs)'}`}
      >
        {option.label}
      </Button>
    ))}
  </div>
);

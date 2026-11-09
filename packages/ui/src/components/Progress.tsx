import { clsx } from "clsx";
import { ProgressBar as RACProgressBar, Label } from "react-aria-components";

/** Indicateur de chargement indéterminé. label="" quand un libellé visible existe déjà à côté. */
export function Spinner({ size = 16, label = "Chargement" }: { size?: number; label?: string }) {
  return (
    <RACProgressBar
      isIndeterminate
      aria-label={label || undefined}
      aria-hidden={label === "" ? true : undefined}
      className="inline-flex"
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="animate-spin motion-reduce:animate-[spin_2s_linear_infinite]"
      >
        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </RACProgressBar>
  );
}

export function ProgressBar({ label, value, className }: { label: string; value?: number; className?: string }) {
  const indeterminate = value === undefined;
  return (
    <RACProgressBar
      value={value}
      isIndeterminate={indeterminate}
      className={clsx("flex w-full flex-col gap-1", className)}
    >
      {({ percentage, valueText }) => (
        <>
          <div className="flex justify-between text-sm">
            <Label>{label}</Label>
            {!indeterminate && <span className="text-muted">{valueText}</span>}
          </div>
          <div className="h-1.5 overflow-hidden rounded-pill bg-surface-hover forced-colors:border forced-colors:border-[CanvasText]">
            <div
              className={clsx(
                "h-full rounded-pill bg-accent forced-colors:bg-[Highlight]",
                indeterminate && "w-1/3 animate-[progress-slide_1.2s_ease-in-out_infinite]",
              )}
              style={indeterminate ? undefined : { width: `${percentage ?? 0}%` }}
            />
          </div>
        </>
      )}
    </RACProgressBar>
  );
}

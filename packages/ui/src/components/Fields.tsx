import { clsx } from "clsx";
import { Check, ChevronDown, Minus, Plus, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import {
  Button as RACButton,
  Checkbox as RACCheckbox,
  type CheckboxProps as RACCheckboxProps,
  FieldError,
  Group,
  Input,
  Label,
  ListBox,
  ListBoxItem,
  NumberField as RACNumberField,
  type NumberFieldProps as RACNumberFieldProps,
  Popover,
  Radio as RACRadio,
  RadioGroup as RACRadioGroup,
  type RadioGroupProps as RACRadioGroupProps,
  SearchField as RACSearchField,
  type SearchFieldProps as RACSearchFieldProps,
  Select as RACSelect,
  type SelectProps as RACSelectProps,
  SelectValue,
  Slider as RACSlider,
  type SliderProps as RACSliderProps,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Switch as RACSwitch,
  type SwitchProps as RACSwitchProps,
  Text,
  TextField as RACTextField,
  type TextFieldProps as RACTextFieldProps,
} from "react-aria-components";

const inputBox =
  "focus-ring transition-control rounded-md border border-border-input bg-bg text-fg placeholder:text-muted data-hovered:border-fg data-invalid:border-danger data-disabled:opacity-45";
const fieldLabel = "text-sm font-medium text-fg";

interface FieldBase {
  label?: string;
  description?: string;
  errorMessage?: string;
  size?: "sm" | "md";
  className?: string;
}

const h = (s: "sm" | "md") => (s === "sm" ? "h-(--control-sm) text-sm" : "h-(--control-md) text-base");

export function TextField({ label, description, errorMessage, size = "md", className, placeholder, ...props }: FieldBase & Omit<RACTextFieldProps, "className"> & { placeholder?: string }) {
  return (
    <RACTextField {...props} className={clsx("flex flex-col gap-1", className)}>
      {label && <Label className={fieldLabel}>{label}</Label>}
      <Input placeholder={placeholder} className={clsx(inputBox, h(size), "px-2.5")} />
      {description && <Text slot="description" className="text-sm text-muted">{description}</Text>}
      <FieldError className="flex items-center gap-1 text-sm text-danger">{errorMessage}</FieldError>
    </RACTextField>
  );
}

export function SearchField({ label, size = "md", className, placeholder, ...props }: FieldBase & Omit<RACSearchFieldProps, "className"> & { placeholder?: string }) {
  return (
    <RACSearchField {...props} aria-label={label} className={clsx("group relative flex items-center", className)}>
      <Search aria-hidden size={16} className="pointer-events-none absolute left-2.5 text-muted" />
      <Input
        placeholder={placeholder}
        className={clsx(inputBox, h(size), "w-full pl-8 pr-8 [&::-webkit-search-cancel-button]:hidden")}
      />
      <RACButton
        aria-label="Effacer"
        className="focus-ring absolute right-1 grid size-6 place-items-center rounded-sm text-muted data-hovered:bg-surface-hover group-data-empty:hidden"
      >
        <X size={14} aria-hidden />
      </RACButton>
    </RACSearchField>
  );
}

export function NumberField({ label, size = "sm", className, suffix, hideStepper, ...props }: FieldBase & Omit<RACNumberFieldProps, "className"> & { suffix?: ReactNode; hideStepper?: boolean }) {
  return (
    <RACNumberField {...props} aria-label={props["aria-label"] ?? label} className={clsx("flex flex-col gap-1", className)}>
      {label && !props["aria-label"] && <Label className={fieldLabel}>{label}</Label>}
      <Group className={clsx(inputBox, h(size), "flex items-center overflow-hidden data-focus-within:outline-2 data-focus-within:outline-focus data-focus-within:outline-offset-2")}>
        {!hideStepper && (
          <RACButton slot="decrement" className="grid h-full w-6 place-items-center text-muted data-hovered:bg-surface-hover">
            <Minus size={12} aria-hidden />
          </RACButton>
        )}
        <Input className="h-full w-full min-w-0 bg-transparent px-1 text-center tabular-nums outline-none" />
        {suffix && <span className="pr-2 text-muted">{suffix}</span>}
        {!hideStepper && (
          <RACButton slot="increment" className="grid h-full w-6 place-items-center text-muted data-hovered:bg-surface-hover">
            <Plus size={12} aria-hidden />
          </RACButton>
        )}
      </Group>
    </RACNumberField>
  );
}

export interface SelectOption {
  id: string;
  label: string;
}

export function Select({ label, options, size = "md", className, ...props }: FieldBase & Omit<RACSelectProps<SelectOption>, "className" | "children"> & { options: SelectOption[] }) {
  // Enveloppe : RAC ajoute un <select> caché en frère (formulaires), qui sinon occupe une case de grille.
  return (
    <div className={className}>
    <RACSelect {...props} className="flex flex-col gap-1">
      {label && <Label className={fieldLabel}>{label}</Label>}
      <RACButton className={clsx(inputBox, h(size), "flex items-center justify-between gap-2 px-2.5 text-left data-pressed:bg-surface-hover")}>
        <SelectValue className="truncate data-placeholder:text-muted" />
        <ChevronDown size={16} aria-hidden className="text-muted" />
      </RACButton>
      <Popover className="min-w-(--trigger-width) rounded-lg border border-border bg-surface-raised p-1 shadow-pop">
        <ListBox items={options} className="outline-none">
          {(item) => (
            <ListBoxItem
              id={item.id}
              textValue={item.label}
              className="focus-ring-inset flex h-8 items-center justify-between gap-3 rounded-sm px-2 text-base data-focused:bg-surface-hover data-selected:font-semibold"
            >
              {({ isSelected }) => (
                <>
                  {item.label}
                  {isSelected && <Check size={16} aria-hidden className="text-accent-text" />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </RACSelect>
    </div>
  );
}

const boxBase =
  "grid size-4 shrink-0 place-items-center rounded-sm border border-border-input bg-bg transition-control group-data-selected:border-accent group-data-selected:bg-accent group-data-indeterminate:border-accent group-data-indeterminate:bg-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus group-data-focus-visible:outline-offset-2 group-data-invalid:border-danger";

export function Checkbox({ children, className, ...props }: Omit<RACCheckboxProps, "className" | "children"> & { children: ReactNode; className?: string }) {
  return (
    <RACCheckbox {...props} className={clsx("group flex min-h-7 items-center gap-2 text-base data-disabled:opacity-45", className)}>
      {({ isSelected, isIndeterminate }) => (
        <>
          <span className={boxBase} aria-hidden>
            {isIndeterminate ? <Minus size={12} strokeWidth={3} className="text-on-accent" /> : isSelected ? <Check size={12} strokeWidth={3} className="text-on-accent" /> : null}
          </span>
          {children}
        </>
      )}
    </RACCheckbox>
  );
}

export function RadioGroup({ label, options, className, ...props }: Omit<RACRadioGroupProps, "className" | "children"> & { label: string; options: SelectOption[]; className?: string }) {
  return (
    <RACRadioGroup {...props} className={clsx("flex flex-col gap-1", className)}>
      <Label className={fieldLabel}>{label}</Label>
      {options.map((o) => (
        <RACRadio key={o.id} value={o.id} className="group flex min-h-7 items-center gap-2 text-base data-disabled:opacity-45">
          <span
            aria-hidden
            className="grid size-4 place-items-center rounded-pill border border-border-input bg-bg group-data-selected:border-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus group-data-focus-visible:outline-offset-2"
          >
            <span className="size-2 rounded-pill bg-transparent group-data-selected:bg-accent" />
          </span>
          {o.label}
        </RACRadio>
      ))}
    </RACRadioGroup>
  );
}

export function Switch({ children, className, ...props }: Omit<RACSwitchProps, "className" | "children"> & { children: ReactNode; className?: string }) {
  return (
    <RACSwitch {...props} className={clsx("group flex min-h-7 items-center gap-2.5 text-base data-disabled:opacity-45", className)}>
      <span
        aria-hidden
        className="flex h-5 w-9 shrink-0 items-center rounded-pill border border-border-input bg-surface-hover p-0.5 transition-control group-data-selected:border-accent group-data-selected:bg-accent group-data-focus-visible:outline-2 group-data-focus-visible:outline-focus group-data-focus-visible:outline-offset-2"
      >
        <span className="size-3.5 rounded-pill bg-fg transition-transform duration-(--motion-fast) group-data-selected:translate-x-4 group-data-selected:bg-on-accent forced-colors:bg-[CanvasText]" />
      </span>
      {children}
    </RACSwitch>
  );
}

export function Slider({ label, className, unit = "", ...props }: Omit<RACSliderProps<number>, "className" | "children"> & { label: string; className?: string; unit?: string }) {
  return (
    <RACSlider {...props} className={clsx("flex w-full flex-col gap-1.5", className)}>
      <div className="flex justify-between text-sm">
        <Label className="font-medium">{label}</Label>
        <SliderOutput className="tabular-nums text-muted">{({ state }) => `${state.getThumbValueLabel(0)}${unit}`}</SliderOutput>
      </div>
      <SliderTrack className="relative h-5 w-full">
        {({ state }) => (
          <>
            <div className="absolute top-1/2 h-1 w-full -translate-y-1/2 rounded-pill bg-border-strong" />
            <div
              className="absolute top-1/2 h-1 -translate-y-1/2 rounded-pill bg-accent"
              style={{ width: `${state.getThumbPercent(0) * 100}%` }}
            />
            <SliderThumb className="top-1/2 size-4 rounded-pill border-2 border-accent bg-bg shadow-raised data-dragging:bg-accent data-focus-visible:outline-2 data-focus-visible:outline-focus data-focus-visible:outline-offset-2" />
          </>
        )}
      </SliderTrack>
    </RACSlider>
  );
}

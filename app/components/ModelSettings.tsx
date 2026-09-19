"use client";

import { Info, X } from "lucide-react";

export interface GenerationSettings {
  temperature: number;
  topK: number | null;
  topP: number | null;
  maxOutputTokens: number | null;
  frequencyPenalty: number;
  presencePenalty: number;
  stopSequence: string;
  seed: number | null;
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  temperature: 0.5,
  topK: null,
  topP: null,
  maxOutputTokens: null,
  frequencyPenalty: 0,
  presencePenalty: 0,
  stopSequence: "",
  seed: null,
};

// Builds the payload sent to /api/chat. Temperature always has a concrete
// value, so it's always included. The rest are only included when the user
// actually set them. Note: live testing found every currently available
// model rejects any non-zero frequency/presence penalty ("Penalty is not
// enabled for this model") — 0 is a no-op everywhere, so it's still omitted
// at the default; a non-zero value will reach the API and surface that real
// error to the user if picked.
export function buildGenerationConfigPayload(settings: GenerationSettings) {
  const config: Record<string, unknown> = {
    temperature: settings.temperature,
  };
  if (settings.frequencyPenalty !== 0) config.frequencyPenalty = settings.frequencyPenalty;
  if (settings.presencePenalty !== 0) config.presencePenalty = settings.presencePenalty;
  if (settings.topK !== null) config.topK = settings.topK;
  if (settings.topP !== null) config.topP = settings.topP;
  if (settings.maxOutputTokens !== null) config.maxOutputTokens = settings.maxOutputTokens;
  if (settings.seed !== null) config.seed = settings.seed;

  const stopSequences = settings.stopSequence
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (stopSequences.length > 0) config.stopSequences = stopSequences;

  return config;
}

function Tooltip({ text }: { text: string }) {
  return (
    <span className="group/tip relative inline-flex">
      <Info size={14} className="text-gray-400 cursor-help" />
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2 rounded-lg bg-gray-900 px-3 py-2 text-xs leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-hover/tip:opacity-100">
        {text}
      </span>
    </span>
  );
}

function FieldLabel({
  label,
  tooltip,
  rightText,
}: {
  label: string;
  tooltip: string;
  rightText?: string;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between">
      <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
        {label}
        <Tooltip text={tooltip} />
      </span>
      {rightText && <span className="text-xs text-gray-400">{rightText}</span>}
    </div>
  );
}

function RangeField({
  label,
  tooltip,
  min,
  max,
  step,
  defaultLabel,
  value,
  onChange,
  disabled,
  disabledNote,
}: {
  label: string;
  tooltip: string;
  min: number;
  max: number;
  step: number;
  defaultLabel: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  disabledNote?: string;
}) {
  return (
    <div className={disabled ? "opacity-50" : undefined}>
      <FieldLabel label={label} tooltip={tooltip} rightText={value.toFixed(1)} />
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-600 disabled:cursor-not-allowed"
      />
      <div className="mt-1 flex justify-between text-xs text-gray-400">
        <span>{min}</span>
        <span>{defaultLabel}</span>
        <span>{max}</span>
      </div>
      {disabled && disabledNote && (
        <p className="mt-1.5 text-xs text-amber-600">{disabledNote}</p>
      )}
    </div>
  );
}

function NumberField({
  label,
  tooltip,
  rightText,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string;
  tooltip: string;
  rightText?: string;
  min?: number;
  max?: number;
  step?: number;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  return (
    <div>
      <FieldLabel label={label} tooltip={tooltip} rightText={rightText} />
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        placeholder="Model default"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );
}

interface ModelSettingsProps {
  open: boolean;
  settings: GenerationSettings;
  onChange: (settings: GenerationSettings) => void;
  onClose: () => void;
}

export default function ModelSettings({ open, settings, onChange, onClose }: ModelSettingsProps) {
  if (!open) return null;

  const set = <K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4">
          <h2 className="text-lg font-semibold text-gray-900">Model settings</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100"
          >
            <X size={18} />
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          <RangeField
            label="Temperature"
            tooltip="Controls randomness. Lower values give more focused, predictable answers; higher values give more creative, varied answers."
            min={0}
            max={2}
            step={0.1}
            defaultLabel="default 0.5"
            value={settings.temperature}
            onChange={(v) => set("temperature", v)}
          />

          <NumberField
            label="Top K"
            tooltip="At each step, only the K most likely next words are considered before one is picked. A lower value keeps the model's word choices safer and more predictable; leave blank to use the model's default."
            rightText="min 1"
            min={1}
            step={1}
            value={settings.topK}
            onChange={(v) => set("topK", v)}
          />

          <NumberField
            label="Top P"
            tooltip="Words are picked from the smallest set whose combined probability reaches this value. Lower values make output more focused; higher values allow more variety. Leave blank to use the model's default."
            rightText="0 to 1"
            min={0}
            max={1}
            step={0.01}
            value={settings.topP}
            onChange={(v) => set("topP", v)}
          />

          <NumberField
            label="Output Tokens"
            tooltip="The maximum number of tokens the model is allowed to generate in its reply. Leave blank to use the model's default limit."
            rightText="positive integer"
            min={1}
            step={1}
            value={settings.maxOutputTokens}
            onChange={(v) => set("maxOutputTokens", v)}
          />

          <RangeField
            label="Frequency Penalty"
            tooltip="Positive values discourage the model from repeating the same words or phrases it has already used, pushing it toward more varied wording. Note: every currently available model rejects a non-zero value here with a clear error (confirmed live) — this may change as Google rolls the feature out."
            min={-2}
            max={2}
            step={0.1}
            defaultLabel="default 0"
            value={settings.frequencyPenalty}
            onChange={(v) => set("frequencyPenalty", v)}
          />

          <RangeField
            label="Presence Penalty"
            tooltip="Positive values discourage the model from bringing up any topic it has already mentioned at all (even once), pushing it toward introducing new ideas. Note: every currently available model rejects a non-zero value here with a clear error (confirmed live) — this may change as Google rolls the feature out."
            min={-2}
            max={2}
            step={0.1}
            defaultLabel="default 0"
            value={settings.presencePenalty}
            onChange={(v) => set("presencePenalty", v)}
          />

          <div>
            <FieldLabel
              label="Stop Sequence"
              tooltip="If the model generates one of these words or characters, it stops immediately. Separate multiple sequences with commas."
              rightText="word or character"
            />
            <input
              type="text"
              placeholder="e.g. ### or STOP"
              value={settings.stopSequence}
              onChange={(e) => set("stopSequence", e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <NumberField
            label="Seed"
            tooltip="Used for sampling. Fixing this to a specific number makes the model try to give the same response to the same input every time, instead of varying randomly. Leave blank for a random seed each time."
            rightText="integer"
            step={1}
            value={settings.seed}
            onChange={(v) => set("seed", v)}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4">
          <button
            onClick={() => onChange(DEFAULT_GENERATION_SETTINGS)}
            className="rounded-full px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100"
          >
            Reset to defaults
          </button>
          <button
            onClick={onClose}
            className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

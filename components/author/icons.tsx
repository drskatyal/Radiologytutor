// Author-surface icon set. Thin wrappers over lucide-react so glyphs are crisp,
// consistent with the rest of the product, and inherit `currentColor`. The
// export names are unchanged, so every author component keeps importing the
// same symbols.

import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronUp,
  FileText,
  GripVertical,
  Info,
  Layers,
  Mic,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Target,
  Trash2,
  X,
  type LucideProps,
} from "lucide-react";

// All author glyphs render at 20px to match the previous hand-drawn set.
const base = (props: LucideProps): LucideProps => ({
  width: 20,
  height: 20,
  strokeWidth: 1.7,
  "aria-hidden": true,
  ...props,
});

export function PencilIcon(props: LucideProps) {
  return <Pencil {...base(props)} />;
}

export function TrashIcon(props: LucideProps) {
  return <Trash2 {...base(props)} />;
}

export function PlusIcon(props: LucideProps) {
  return <Plus {...base(props)} />;
}

export function ChevronUpIcon(props: LucideProps) {
  return <ChevronUp {...base(props)} />;
}

export function ChevronDownIcon(props: LucideProps) {
  return <ChevronDown {...base(props)} />;
}

export function CheckIcon(props: LucideProps) {
  return <Check {...base(props)} />;
}

export function CloseIcon(props: LucideProps) {
  return <X {...base(props)} />;
}

export function SparkleIcon(props: LucideProps) {
  return <Sparkles {...base(props)} />;
}

export function BackIcon(props: LucideProps) {
  return <ArrowLeft {...base(props)} />;
}

export function GripIcon(props: LucideProps) {
  return <GripVertical {...base(props)} />;
}

export function LayersIcon(props: LucideProps) {
  return <Layers {...base(props)} />;
}

export function TargetIcon(props: LucideProps) {
  return <Target {...base(props)} />;
}

export function DocIcon(props: LucideProps) {
  return <FileText {...base(props)} />;
}

export function PlayIcon(props: LucideProps) {
  return <Play {...base(props)} fill="currentColor" strokeWidth={0} />;
}

export function MicIcon(props: LucideProps) {
  return <Mic {...base(props)} />;
}

export function InfoIcon(props: LucideProps) {
  return <Info {...base(props)} />;
}

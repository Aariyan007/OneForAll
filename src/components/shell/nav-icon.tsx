import {
  IconBell,
  IconBox,
  IconBranch,
  IconBuilding,
  IconDashboard,
  IconFolder,
  IconLayers,
  IconListChecks,
  IconNetwork,
  IconSettings,
  IconSparkle,
  IconTask,
  IconUsers,
} from "@/components/ui/icons";

const ICONS = {
  dashboard: IconDashboard,
  building: IconBuilding,
  layers: IconLayers,
  users: IconUsers,
  folder: IconFolder,
  box: IconBox,
  listChecks: IconListChecks,
  branch: IconBranch,
  network: IconNetwork,
  task: IconTask,
  settings: IconSettings,
  bell: IconBell,
  sparkle: IconSparkle,
} as const;

export function NavIcon({ name, size = 16 }: { name: string; size?: number }) {
  const Icon = ICONS[name as keyof typeof ICONS] ?? IconBox;
  return <Icon size={size} />;
}

import type { SVGProps } from "react";

// The single OneForAll icon set: 24×24 grid, 1.75px rounded strokes, currentColor. Decorative by default
// (aria-hidden); pass a `title` through an adjacent visually-hidden label when an icon carries meaning alone.

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...props }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="3.5" width="7" height="8" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
    <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
    <rect x="3.5" y="14.5" width="7" height="6" rx="1.5" />
  </Svg>
);
export const IconBuilding = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20.5V5.5A1.5 1.5 0 0 1 5.5 4h8A1.5 1.5 0 0 1 15 5.5v15" />
    <path d="M15 9.5h3.5A1.5 1.5 0 0 1 20 11v9.5" />
    <path d="M2.5 20.5h19" />
    <path d="M7.5 8h4M7.5 11.5h4M7.5 15h4" />
  </Svg>
);
export const IconLayers = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
    <path d="m3.5 12 8.5 4.5 8.5-4.5" />
    <path d="m3.5 16 8.5 4.5 8.5-4.5" />
  </Svg>
);
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8.5" r="3.5" />
    <path d="M2.5 20c.6-3.4 3.2-5.5 6.5-5.5s5.9 2.1 6.5 5.5" />
    <path d="M15.5 5.2a3.5 3.5 0 0 1 0 6.6" />
    <path d="M18 14.8c1.9.7 3.2 2.5 3.5 5.2" />
  </Svg>
);
export const IconFolder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 7A1.5 1.5 0 0 1 5 5.5h4.2l2 2.2H19A1.5 1.5 0 0 1 20.5 9.2V17A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17V7Z" />
  </Svg>
);
export const IconListChecks = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 6 1.5 1.5L8 4.5" />
    <path d="m3.5 12.5 1.5 1.5L8 11" />
    <path d="M11.5 6.5h9M11.5 13h9M11.5 19.5h9" />
    <circle cx="5.5" cy="19.5" r="1.25" />
  </Svg>
);
export const IconTask = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="m8.5 12 2.5 2.5 4.5-5" />
  </Svg>
);
export const IconBranch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.5" cy="5.5" r="2" />
    <circle cx="6.5" cy="18.5" r="2" />
    <circle cx="17.5" cy="7.5" r="2" />
    <path d="M6.5 7.5v9" />
    <path d="M17.5 9.5c0 4-4 4.5-9 7.5" />
  </Svg>
);
export const IconCommit = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M2.5 12h6M15.5 12h6" />
  </Svg>
);
export const IconNetwork = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="5" r="2" />
    <circle cx="5" cy="18" r="2" />
    <circle cx="19" cy="18" r="2" />
    <circle cx="12" cy="13" r="2.25" />
    <path d="M12 7v3.75M10.2 14.4 6.5 16.7M13.8 14.4l3.7 2.3" />
  </Svg>
);
export const IconCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8.5 7.5-5 4.5 5 4.5M15.5 7.5l5 4.5-5 4.5" />
    <path d="m13.5 5-3 14" />
  </Svg>
);
export const IconFileCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 3.5H7A1.5 1.5 0 0 0 5.5 5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8L14 3.5Z" />
    <path d="M14 3.5V8h4.5" />
    <path d="m10 12-2 2 2 2M14 12l2 2-2 2" />
  </Svg>
);
export const IconSymbol = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4.5c-2 0-2.5 1-2.5 2.5v2.5c0 1.2-.8 2-2 2.5 1.2.5 2 1.3 2 2.5V17c0 1.5.5 2.5 2.5 2.5" />
    <path d="M16 4.5c2 0 2.5 1 2.5 2.5v2.5c0 1.2.8 2 2 2.5-1.2.5-2 1.3-2 2.5V17c0 1.5-.5 2.5-2.5 2.5" />
    <circle cx="12" cy="12" r="1.25" />
  </Svg>
);
export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);
export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" />
  </Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15 15 5.5 5.5" />
  </Svg>
);
export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </Svg>
);
export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z" />
  </Svg>
);
export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15l1.5-2Z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </Svg>
);
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.5 6 6 6-6 6" />
  </Svg>
);
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9.5 6 6 6-6" />
  </Svg>
);
export const IconChevronsUpDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
  </Svg>
);
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 12h15M13.5 6l6 6-6 6" />
  </Svg>
);
export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12h-15M10.5 6l-6 6 6 6" />
  </Svg>
);
export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconMinus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 12h14" />
  </Svg>
);
export const IconFit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" />
  </Svg>
);
export const IconFocus = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="2.5" />
    <circle cx="12" cy="12" r="7.5" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2" />
  </Svg>
);
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);
export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h8" />
    <path d="M10 12h10M16.5 8.5 20 12l-3.5 3.5" />
  </Svg>
);
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.3 4.2 2.9 17.4A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3.1L13.7 4.2a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9.5v4M12 17h.01" />
  </Svg>
);
export const IconCheckCircle = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.3 4.6-5" />
  </Svg>
);
export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8h.01" />
  </Svg>
);
export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);
export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="10" rx="2" />
    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
  </Svg>
);
export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M3.5 12h17M12 3.5c2.3 2.4 3.5 5.2 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.2-3.5-8.5S9.7 5.9 12 3.5Z" />
  </Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.5 4.5h6v6M19.5 4.5 11 13" />
    <path d="M17.5 14v4.5A1.5 1.5 0 0 1 16 20H5.5A1.5 1.5 0 0 1 4 18.5V8a1.5 1.5 0 0 1 1.5-1.5H10" />
  </Svg>
);
export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2.5-6 5 12 2.5-6h4" />
  </Svg>
);
export const IconUnlink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7" />
    <path d="M3.5 3.5 20.5 20.5" />
  </Svg>
);
export const IconSparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5c.5 4.2 2.3 6 6.5 6.5-4.2.5-6 2.3-6.5 6.5-.5-4.2-2.3-6-6.5-6.5 4.2-.5 6-2.3 6.5-6.5Z" />
    <path d="M18.5 15.5c.2 1.8 1 2.6 2.5 2.8-1.5.2-2.3 1-2.5 2.7-.2-1.7-1-2.5-2.5-2.7 1.5-.2 2.3-1 2.5-2.8Z" />
  </Svg>
);
export const IconBox = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 8 4v9l-8 4-8-4v-9l8-4Z" />
    <path d="m4 7.5 8 4 8-4M12 11.5v9" />
  </Svg>
);
export const IconLogo = (p: IconProps) => (
  <Svg {...p} strokeWidth={2}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    <path d="M12 4v4.5M12 15.5V20M4 12h4.5M15.5 12H20" />
  </Svg>
);

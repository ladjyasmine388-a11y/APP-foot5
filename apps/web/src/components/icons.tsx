import type { ComponentProps } from 'react';

type IconProps = ComponentProps<'svg'>;

/** Icônes décoratives (le libellé accessible est toujours porté par le texte voisin ou un aria-label). */
function Svg({ children, ...rest }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => <Svg {...p}><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></Svg>;
export const PitchIcon = (p: IconProps) => <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M12 5v14" /><circle cx="12" cy="12" r="2.5" /></Svg>;
export const UsersIcon = (p: IconProps) => <Svg {...p}><circle cx="9" cy="8" r="3.2" /><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" /><circle cx="17" cy="9" r="2.5" /><path d="M16.5 14.2c2.6.3 4.5 2.4 4.5 5.8" /></Svg>;
export const TicketIcon = (p: IconProps) => <Svg {...p}><path d="M4 8a2 2 0 002-2h12a2 2 0 002 2v2a2 2 0 000 4v2a2 2 0 00-2 2H6a2 2 0 00-2-2v-2a2 2 0 000-4z" /><path d="M10 6v12" strokeDasharray="2 3" /></Svg>;
export const UserIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5" /></Svg>;
export const BellIcon = (p: IconProps) => <Svg {...p}><path d="M6 17V11a6 6 0 1112 0v6l1.5 2h-15z" /><path d="M10 21h4" /></Svg>;
export const SwordsIcon = (p: IconProps) => <Svg {...p}><path d="M5 19L19 5M15 5h4v4M5 5l14 14M5 9V5h4" /></Svg>;
export const ChartIcon = (p: IconProps) => <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
export const ShieldIcon = (p: IconProps) => <Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" /><path d="M9 12l2 2 4-4" /></Svg>;
export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>;
export const CheckIcon = (p: IconProps) => <Svg {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const ClockIcon = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
export const PinIcon = (p: IconProps) => <Svg {...p}><path d="M12 21s7-6 7-11a7 7 0 10-14 0c0 5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" /></Svg>;
export const StarIcon = (p: IconProps) => <Svg {...p}><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" /></Svg>;

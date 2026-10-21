// Design tokens para motion (consumidos por las React islands)
// Spec: PROJECT.md §21.5

export const duration = {
  instant: 0.1,
  fast:    0.2,
  base:    0.3,
  slow:    0.5,
  page:    0.6,
} as const;

export const easing = {
  out:    [0.22, 1, 0.36, 1] as const,
  inOut:  [0.64, 0, 0.35, 1] as const,
  bounce: [0.16, 1, 0.3, 1]   as const,
} as const;

export const semantic = {
  hoverLift: { y: -4, scale: 1.02, transition: { duration: duration.fast, ease: easing.out } },
  tapPress:  { scale: 0.98, transition: { duration: duration.instant } },
  fadeIn:    { opacity: [0, 1], transition: { duration: duration.base, ease: easing.out } },
} as const;

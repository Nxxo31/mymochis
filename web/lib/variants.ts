// Variants library para Framer Motion (motion@^12)
// Spec: PROJECT.md §21.6
import type { Variants } from 'motion/react';
import { duration, easing } from './motion-tokens';

export const stagger = (delay = 0.08, initial = 0.05): Variants => ({
  hidden: {},
  visible: {
    transition: { delayChildren: initial, staggerChildren: delay },
  },
});

export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 16 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: duration.slow, ease: easing.bounce },
  },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.base, ease: easing.out } },
};

export const scaleIn: Variants = {
  hidden: { opacity: 0, scale: 0.96 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: duration.base, ease: easing.out },
  },
};

export const cardHover = {
  whileHover: { y: -4, scale: 1.02, transition: { duration: duration.fast, ease: easing.out } },
  whileTap:   { scale: 0.98 },
};

export const reduceVariants: Variants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { duration: duration.instant } },
};

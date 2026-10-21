// AnimatedHero — entrypoint del island animado
// Spec: PROJECT.md §21.6 + §21.8
import { motion, useReducedMotion } from 'motion/react';
import { stagger, fadeUp, fadeIn, reduceVariants } from '../lib/variants';

export interface AnimatedHeroProps {
  status: string;
  titleHtml: string;
  subtitle: string;
  ctaLabel: string;
  ctaHref: string;
}

export function AnimatedHero({ status, titleHtml, subtitle, ctaLabel, ctaHref }: AnimatedHeroProps) {
  const reduce = useReducedMotion();
  const container = reduce ? fadeIn : stagger();
  const item = reduce ? reduceVariants : fadeUp;

  return (
    <motion.div
      className="hero-island__content"
      initial="hidden"
      animate="visible"
      variants={container}
    >
      <motion.div className="hero-island__status" variants={item}>
        <span className="hero-island__status-dot" />
        {status}
      </motion.div>
      <motion.h1 className="hero-island__title" variants={item} dangerouslySetInnerHTML={{ __html: titleHtml }} />
      <motion.p className="hero-island__subtitle" variants={item}>{subtitle}</motion.p>
      <motion.a
        className="hero-island__cta"
        href={ctaHref}
        variants={item}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.98 }}
      >
        {ctaLabel} →
      </motion.a>
    </motion.div>
  );
}

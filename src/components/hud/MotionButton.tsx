import React from 'react';
import { motion } from 'framer-motion';

export interface MotionButtonProps extends React.ComponentProps<typeof motion.button> {
  variant?: 'default' | 'danger' | 'active';
  children: React.ReactNode;
}

export function MotionButton(props: MotionButtonProps) {
  const { variant = 'default', children, className, disabled, ...rest } = props;

  const variantClass =
    variant === 'danger' ? 'hud-btn--danger' : variant === 'active' ? 'hud-btn--active' : '';

  const mergedClassName = ['hud-btn', variantClass, className].filter(Boolean).join(' ');

  const interactionProps = disabled
    ? {}
    : {
        whileHover: { scale: 1.03 },
        whileTap: { scale: 0.94 },
        transition: { type: 'spring' as const, stiffness: 500, damping: 30 },
      };

  return (
    <motion.button
      className={mergedClassName}
      disabled={disabled}
      {...interactionProps}
      {...rest}
    >
      {children}
    </motion.button>
  );
}

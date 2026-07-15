import type {ButtonHTMLAttributes, ReactNode} from 'react';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  children: ReactNode;
  compact?: boolean;
}

export function IconButton({label, children, compact = false, className = '', ...props}: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-button ${compact ? 'icon-button--compact' : ''} ${className}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

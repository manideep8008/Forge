/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        forge: {
          bg: '#0a0e1a',
          'bg-alt': '#0d1226',
          surface: 'rgba(15, 23, 42, 0.6)',
          'surface-solid': '#111827',
          border: 'rgba(56, 68, 100, 0.4)',
          'border-bright': 'rgba(99, 119, 180, 0.3)',
          accent: '#6366f1',
          'accent-hover': '#818cf8',
          'accent-glow': 'rgba(99, 102, 241, 0.15)',
          secondary: '#8b5cf6',
          muted: '#7c85a6',
          text: '#e8ecf4',
          'text-dim': '#9ca3bf',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'glow-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
      boxShadow: {
        'glow-sm': '0 0 15px -3px rgba(99, 102, 241, 0.15)',
        'glow-md': '0 0 25px -5px rgba(99, 102, 241, 0.2)',
        'glow-lg': '0 0 40px -8px rgba(99, 102, 241, 0.25)',
        'glow-emerald': '0 0 20px -5px rgba(52, 211, 153, 0.2)',
        'glow-red': '0 0 20px -5px rgba(248, 113, 113, 0.2)',
        'glass': '0 8px 32px rgba(0, 0, 0, 0.3)',
        'glass-lg': '0 16px 48px rgba(0, 0, 0, 0.4)',
      },
      animation: {
        'pulse-blue': 'pulse-blue 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'slide-up': 'slide-up 0.3s ease-out',
        'slide-down': 'slide-down 0.2s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        'shimmer': 'shimmer 2s linear infinite',
      },
      keyframes: {
        'pulse-blue': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 15px -3px rgba(99, 102, 241, 0.15)' },
          '50%': { boxShadow: '0 0 25px -3px rgba(99, 102, 241, 0.3)' },
        },
        'slide-up': {
          '0%': { opacity: '0', transform: 'translateY(10px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-down': {
          '0%': { opacity: '0', transform: 'translateY(-5px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        'scale-in': {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'shimmer': {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
      },
    },
  },
  plugins: [],
};

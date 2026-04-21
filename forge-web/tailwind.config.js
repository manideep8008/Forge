/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        forge: {
          bg: '#0d1117',
          'bg-alt': '#161b22',
          surface: 'rgba(22, 27, 34, 0.7)',
          'surface-solid': '#161b22',
          border: 'rgba(48, 54, 61, 0.8)',
          'border-bright': 'rgba(110, 118, 129, 0.4)',
          accent: '#e6edf3',
          'accent-hover': '#ffffff',
          'accent-glow': 'rgba(230, 237, 243, 0.08)',
          secondary: '#8b949e',
          muted: '#6e7681',
          text: '#e6edf3',
          'text-dim': '#8b949e',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'glow-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
      },
      boxShadow: {
        'glow-sm': '0 0 15px -3px rgba(230, 237, 243, 0.06)',
        'glow-md': '0 0 25px -5px rgba(230, 237, 243, 0.08)',
        'glow-lg': '0 0 40px -8px rgba(230, 237, 243, 0.10)',
        'glow-emerald': '0 0 20px -5px rgba(52, 211, 153, 0.2)',
        'glow-red': '0 0 20px -5px rgba(248, 113, 113, 0.2)',
        'glass': '0 8px 32px rgba(0, 0, 0, 0.4)',
        'glass-lg': '0 16px 48px rgba(0, 0, 0, 0.5)',
      },
      animation: {
        'pulse-blue': 'pulse-blue 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'glow-pulse': 'glow-pulse 2s ease-in-out infinite',
        'slide-up': 'slide-up 0.3s ease-out',
        'slide-down': 'slide-down 0.2s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        'shimmer': 'shimmer 2s linear infinite',
        'pulse-subtle': 'pulse-subtle 3s ease-in-out infinite',
      },
      keyframes: {
        'pulse-blue': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.5' },
        },
        'glow-pulse': {
          '0%, 100%': { boxShadow: '0 0 15px -3px rgba(230, 237, 243, 0.06)' },
          '50%': { boxShadow: '0 0 25px -3px rgba(230, 237, 243, 0.12)' },
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
        'pulse-subtle': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.85' },
        },
      },
    },
  },
  plugins: [],
};

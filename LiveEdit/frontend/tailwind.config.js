/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          950: '#05080a',
          900: '#0a1012',
          850: '#0d1518',
          800: '#111c1f',
          700: '#162326',
          600: '#1c2e32',
          500: '#263d42',
        },
        emerald: {
          50: '#e9fff5',
          100: '#c8ffe6',
          200: '#93ffd0',
          300: '#54f7b4',
          400: '#22e39a',
          500: '#0fc985',
          600: '#0aa46e',
          700: '#0c825a',
          800: '#0f664a',
          900: '#0f533e',
          950: '#052e22',
        },
        teal: {
          50: '#effffe',
          100: '#c7fffb',
          200: '#90fff7',
          300: '#4dfaee',
          400: '#17e4db',
          500: '#02c3bd',
          600: '#019b98',
          700: '#087a7a',
          800: '#0d6162',
          900: '#0f5153',
          950: '#022f31',
        },
      },
      fontFamily: {
        sans: ['"Inter"', '"Segoe UI"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', '"Consolas"', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 12px 0 rgba(34, 227, 154, 0.45)',
        'glow-teal': '0 0 12px 0 rgba(23, 228, 219, 0.45)',
        'glow-lg': '0 0 24px 4px rgba(34, 227, 154, 0.35)',
        panel: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 0 0 1px rgba(255,255,255,0.04) inset',
      },
      backgroundImage: {
        'grid-fade': 'radial-gradient(circle at 50% 0%, rgba(23,228,219,0.08), transparent 60%)',
      },
      animation: {
        pulseGlow: 'pulseGlow 2s ease-in-out infinite',
        blink: 'blink 1s step-start infinite',
      },
      keyframes: {
        pulseGlow: {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.55 },
        },
        blink: {
          '50%': { opacity: 0 },
        },
      },
    },
  },
  plugins: [],
};

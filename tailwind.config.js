/** Statyczny build Tailwind (zamiast cdn.tailwindcss.com — B6).
 *  Konfiguracja przeniesiona 1:1 z inline tailwind.config w public/index.html. */
module.exports = {
  content: [
    "./public/index.html",
    "./src/client.tsx",
    "./src/handler.ts",
    "./src/lib/**/*.ts",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          blue: "#1565C0",
          bluedark: "#0D47A1",
          bluelight: "#E8F1FB",
          navy: "#14315D",
          orange: "#F26722",
          orangedark: "#D9550F",
        },
      },
      fontFamily: {
        heading: ["Roboto Condensed", "Roboto", "sans-serif"],
      },
    },
  },
  plugins: [],
};

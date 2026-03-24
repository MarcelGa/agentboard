import type { Metadata } from "next";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { getProjectName } from "@/lib/project-name";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-ibm-plex-sans",
  display: "swap",
  weight: ["300", "400", "500", "600", "700"],
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-ibm-plex-mono",
  display: "swap",
  weight: ["300", "400", "500"],
});

export async function generateMetadata(): Promise<Metadata> {
  const projectName = getProjectName();
  return {
    title: {
      template: `%s | ${projectName}`,
      default: `ao | ${projectName}`,
    },
    description: "Dashboard for managing parallel AI coding agents",
  };
}

// Inline script that runs before React hydration to apply the correct theme
// class, preventing a flash of the wrong theme.
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme');
    var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = (stored === 'dark' || stored === 'light') ? stored : (prefersDark ? 'dark' : 'light');
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  } catch(e) {
    document.documentElement.classList.add('dark');
  }
})();
`.trim();

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="bg-[var(--color-bg-base)] text-[var(--color-text-primary)] antialiased">
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}

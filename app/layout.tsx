import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import "./room-theme.css";
import "./classroom.css";
import "./dialog-theme.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "11scat｜一起专注的自习空间",
  description: "共享画面与协作画板，和房间成员交流、同步滴答待办。",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "11scat", statusBarStyle: "default" },
  openGraph: {
    title: "11scat",
    description: "共享画面与协作画板，和房间成员交流、同步滴答待办。",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "11scat",
    description: "共享画面与协作画板，和房间成员交流、同步滴答待办。",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={geistSans.variable}>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Atelier Impasto — 빛으로 읽는 질감",
  description: "WebGPU로 하이트맵과 컬러맵을 결합해 렌더링한 임파스토 유화. 섀도우맵 + 하이트필드 레이마칭 그림자, compute 패스트레이싱.",
};

export const viewport: Viewport = {
  themeColor: "#11100e",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

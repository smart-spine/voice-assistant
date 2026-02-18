import "./globals.css";

export const metadata = {
  title: "Voice Bot Control",
  description: "Unified control panel for API process and Google Meet voice bot"
};

export default function RootLayout({ children }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}

import "./globals.css";

export const metadata = {
  title: "Graphviz Generator — Draw. Layout. Export DOT.",
  description:
    "A visual editor for Graphviz diagrams. Sketch nodes and edges on a canvas, auto-layout with the dot engine, and export clean DOT code.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-slate-50 text-slate-900">
        {children}
      </body>
    </html>
  );
}

import Box from "@mui/material/Box";

// The Piagent mark: π with a terminal cursor, on the same square the website
// and the favicon use. Drawn inline so it needs no request under the CSP.
export function BrandMark({ size = 28 }: { size?: number }) {
  return <Box component="svg" viewBox="0 0 64 64" aria-hidden="true" className="brand-logo"
    sx={{ width: size, height: size, flexShrink: 0, display: "block", borderRadius: `${Math.round(size * .24)}px` }}>
    <rect width="64" height="64" rx="15" fill="#141612" />
    <rect x=".75" y=".75" width="62.5" height="62.5" rx="14.25" fill="none" stroke="#ffffff" strokeOpacity=".12" strokeWidth="1.5" />
    <path d="M13 21.5h27M21 22v22M32.5 22v17.5c0 3 1.6 4.5 4.5 4.5" fill="none" stroke="#f2f2ed" strokeWidth="5.5" strokeLinecap="round" />
    <rect x="44" y="19.5" width="6.5" height="25" rx="1.8" fill="#c6f432" />
  </Box>;
}

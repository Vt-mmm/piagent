import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function safeLink(value: string): string {
  if (value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? value : "";
  } catch { return ""; }
}

export function MarkdownMessage({ children }: { children: string }) {
  return <Box className="markdown-message" sx={{ overflowWrap: "anywhere", lineHeight: 1.75,
    "& > :first-of-type": { mt: 0 }, "& > :last-child": { mb: 0 } }}>
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeLink} components={{
      h1: ({ children: value }) => <Typography component="h2" variant="h5" sx={{ mt: 2.5, mb: 1, fontWeight: 750 }}>{value}</Typography>,
      h2: ({ children: value }) => <Typography component="h3" variant="h6" sx={{ mt: 2.25, mb: .8, fontWeight: 750 }}>{value}</Typography>,
      h3: ({ children: value }) => <Typography component="h4" sx={{ mt: 2, mb: .65, fontWeight: 750 }}>{value}</Typography>,
      h4: ({ children: value }) => <Typography component="h5" variant="body1" sx={{ mt: 1.75, mb: .5, fontWeight: 750 }}>{value}</Typography>,
      p: ({ children: value }) => <Typography component="p" sx={{ my: 1, lineHeight: 1.75 }}>{value}</Typography>,
      ul: ({ children: value }) => <Box component="ul" sx={{ my: 1, pl: 3.25, "& > li": { mb: .45 } }}>{value}</Box>,
      ol: ({ children: value }) => <Box component="ol" sx={{ my: 1, pl: 3.25, "& > li": { mb: .45 } }}>{value}</Box>,
      li: ({ children: value }) => <Box component="li" sx={{ pl: .25 }}>{value}</Box>,
      strong: ({ children: value }) => <Box component="strong" sx={{ fontWeight: 750 }}>{value}</Box>,
      blockquote: ({ children: value }) => <Paper component="blockquote" variant="outlined" sx={{ m: "12px 0", px: 1.75, py: .25,
        borderLeft: 3, borderLeftColor: "primary.main", bgcolor: "action.hover", color: "text.secondary" }}>{value}</Paper>,
      code: ({ children: value }) => <Box component="code" sx={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: ".88em", bgcolor: "action.hover", borderRadius: .8, px: .55, py: .15 }}>{value}</Box>,
      pre: ({ children: value }) => <Box component="pre" sx={{ my: 1.4, p: 1.5, overflowX: "auto", borderRadius: 2,
        bgcolor: "action.hover", border: 1, borderColor: "divider", whiteSpace: "pre", "& code": { bgcolor: "transparent", p: 0 } }}>{value}</Box>,
      a: ({ href, children: value }) => href ? <Link href={href} target={href.startsWith("#") ? undefined : "_blank"}
        rel={href.startsWith("#") ? undefined : "noopener noreferrer"} underline="hover">{value}</Link> : <>{value}</>,
      img: ({ alt }) => <Typography component="span" variant="caption" color="text.secondary">[{alt || "image"}]</Typography>,
      table: ({ children: value }) => <Box sx={{ my: 1.5, overflowX: "auto" }}><Box component="table" sx={{ width: "100%",
        borderCollapse: "collapse", fontSize: ".92rem", "th, td": { border: 1, borderColor: "divider", px: 1.2, py: .8, textAlign: "left" },
        th: { bgcolor: "action.hover", fontWeight: 750 } }}>{value}</Box></Box>,
      hr: () => <Divider sx={{ my: 2 }} />
    }}>{children}</ReactMarkdown>
  </Box>;
}

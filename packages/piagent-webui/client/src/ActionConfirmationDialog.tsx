import WarningAmberRounded from "@mui/icons-material/WarningAmberRounded";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogContentText from "@mui/material/DialogContentText";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";

export function ActionConfirmationDialog({ open, title, description, confirmLabel, cancelLabel, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  return <Dialog open={open} onClose={onCancel} fullWidth maxWidth="xs" aria-describedby="piagent-confirm-dialog-description"
    slotProps={{ paper: { sx: { borderRadius: 3, p: .5 } } }}>
    <DialogTitle sx={{ display: "flex", alignItems: "center", gap: 1.25, pb: 1 }}>
      <Box sx={{ width: 36, height: 36, borderRadius: 2, display: "grid", placeItems: "center", bgcolor: "warning.main", color: "warning.contrastText" }}>
        <WarningAmberRounded fontSize="small" />
      </Box>
      <Typography component="span" sx={{ fontSize: "1.08rem", fontWeight: 700 }}>{title}</Typography>
    </DialogTitle>
    <DialogContent><DialogContentText id="piagent-confirm-dialog-description" sx={{ color: "text.secondary", lineHeight: 1.65 }}>
      {description}
    </DialogContentText></DialogContent>
    <DialogActions sx={{ px: 2.5, pb: 2, gap: .75 }}>
      <Button color="inherit" onClick={onCancel}>{cancelLabel}</Button>
      <Button variant="contained" color="warning" onClick={onConfirm} autoFocus>{confirmLabel}</Button>
    </DialogActions>
  </Dialog>;
}

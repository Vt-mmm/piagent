import Box from '@mui/material/Box';
import CloseIcon from '@mui/icons-material/Close';
import type { ReactNode } from 'react';

// A tab label with its own close control, as in an editor's tab strip. The
// control is a span (a button cannot sit inside the tab's own button); it
// does not select the tab it closes.
export function closableLabel(text: ReactNode, label: string, onClose: () => void) {
  const close = (event: { stopPropagation(): void; preventDefault(): void }) => { event.stopPropagation(); event.preventDefault(); onClose(); };
  return <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: .75 }}>
    <span>{text}</span>
    <Box component="span" role="button" tabIndex={0} aria-label={label} title={label} onClick={close} onMouseDown={event => event.stopPropagation()}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') close(event); }}
      sx={{ display: 'inline-grid', placeItems: 'center', width: 18, height: 18, borderRadius: '2px', opacity: .7, '&:hover': { opacity: 1, bgcolor: 'action.hover' } }}>
      <CloseIcon sx={{ fontSize: 14 }} />
    </Box>
  </Box>;
}

// Output formats of the report engine.
import { fmtMoney, padR, padL, escHtml, daysBetween, addDays, fmtPct, csvPct, csvCell, mdCell, rep, cmpStr } from './format.js';

export function render_text({ title, cols, out, footer, asOf }) {
  var lines = [];
  lines.push('== ' + title.toUpperCase() + ' ==');
  var head = [];
  for (var c = 0; c < cols.length; c++) head.push(cols[c][3] === 'R' ? padL(cols[c][1], cols[c][2]) : padR(cols[c][1], cols[c][2]));
  lines.push(head.join(' | '));
  var width = 0;
  for (var c2 = 0; c2 < cols.length; c2++) width += cols[c2][2];
  width += (cols.length - 1) * 3;
  lines.push(rep('-', width));
  for (var ri = 0; ri < out.length; ri++) {
    var cells = [];
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '-';
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = String(v);
      cells.push(cols[ci][3] === 'R' ? padL(t, cols[ci][2]) : padR(t, cols[ci][2]));
    }
    lines.push(cells.join(' | '));
  }
  lines.push(rep('-', width));
  if (footer) lines.push(footer);
  lines.push('(' + out.length + ' dong)');
  return lines.join('\n') + '\n';
}

export function render_csv({ title, cols, out, footer, asOf }) {
  var csv = [];
  var hdr = [];
  for (var c = 0; c < cols.length; c++) hdr.push(csvCell(cols[c][1]));
  csv.push(hdr.join(';'));
  for (var ri = 0; ri < out.length; ri++) {
    var cells = [];
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      if (v == null) cells.push('');
      else if (kind === 'm') cells.push(String(Math.round(v)));
      else if (kind === 'p') cells.push(csvPct(v));
      else cells.push(csvCell(v));
    }
    csv.push(cells.join(';'));
  }
  return csv.join('\r\n') + '\r\n';
}

export function render_html({ title, cols, out, footer, asOf }) {
  var h = '<table class="rpt">\n';
  h += '  <caption>' + escHtml(title) + '</caption>\n';
  h += '  <thead><tr>';
  for (var c = 0; c < cols.length; c++) h += '<th' + (cols[c][3] === 'R' ? ' class="num"' : '') + '>' + escHtml(cols[c][1]) + '</th>';
  h += '</tr></thead>\n';
  h += '  <tbody>\n';
  for (var ri = 0; ri < out.length; ri++) {
    h += '    <tr>';
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      var t;
      if (v == null) t = '&nbsp;';
      else if (kind === 'm' || kind === 'i') t = fmtMoney(v);
      else if (kind === 'p') t = fmtPct(v);
      else t = escHtml(v);
      h += '<td' + (cols[ci][3] === 'R' ? ' class="num"' : '') + '>' + t + '</td>';
    }
    h += '</tr>\n';
  }
  h += '  </tbody>\n';
  if (footer) h += '  <tfoot><tr><td colspan="' + cols.length + '">' + escHtml(footer) + '</td></tr></tfoot>\n';
  h += '</table>\n';
  return h;
}

export function render_json({ title, cols, out, footer, asOf }) {
  var payload = { report: title, asOf: asOf, count: out.length, rows: out, footer: footer };
  return JSON.stringify(payload, null, 2);
}

export function render_md({ title, cols, out, footer, asOf }) {
  var md = [];
  md.push('### ' + title);
  md.push('');
  var hd = [];
  var al = [];
  for (var c = 0; c < cols.length; c++) {
    hd.push(mdCell(cols[c][1]));
    al.push(cols[c][3] === 'R' ? '---:' : ':---');
  }
  md.push('| ' + hd.join(' | ') + ' |');
  md.push('| ' + al.join(' | ') + ' |');
  for (var ri = 0; ri < out.length; ri++) {
    var cells = [];
    for (var ci = 0; ci < cols.length; ci++) {
      var v = out[ri][cols[ci][0]];
      var kind = cols[ci][4];
      if (v == null) cells.push('');
      else if (kind === 'm' || kind === 'i') cells.push(fmtMoney(v));
      else if (kind === 'p') cells.push(fmtPct(v));
      else cells.push(mdCell(v));
    }
    md.push('| ' + cells.join(' | ') + ' |');
  }
  if (footer) {
    md.push('');
    md.push('_' + footer + '_');
  }
  return md.join('\n') + '\n';
}

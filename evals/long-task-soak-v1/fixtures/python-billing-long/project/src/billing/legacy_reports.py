# -*- coding: utf-8 -*-
"""
legacy_reports.py -- finance reports for the billing back office.

Ported from the old PHP back office in 2019 (ticket FIN-212) and extended by
whoever needed a report since then. Every report function takes the invoice
records (a list of dicts, one per invoice, see docs/REPORTS.md) and returns
the whole report as one string.

DO NOT CHANGE THE OUTPUT FORMAT. Finance diff these files month to month and
the accountants' import macros parse the CSV variants column by column.

Known debts (nobody had time):
  * every report sorts and filters the records itself
  * the VAT returns were copied country by country when each country went live
  * the CSV variants are copies of the text reports
"""
from decimal import Decimal, ROUND_HALF_EVEN
import datetime
import calendar

CENT = Decimal('0.01')
ZERO = Decimal('0')
HUNDRED = Decimal('100')
TENTH = Decimal('0.1')

STATUS_ORDER = ['paid', 'partially_refunded', 'refunded', 'past_due']

COUNTRY_NAMES = {
    'US': 'United States',
    'DE': 'Germany',
    'FR': 'France',
    'NL': 'Netherlands',
    'ES': 'Spain',
    'IT': 'Italy',
    'GB': 'United Kingdom',
    'JP': 'Japan',
    'VN': 'Vietnam',
    'SE': 'Sweden',
}


def _fmt(d):
    # thousands separators, two decimals
    return '{:,.2f}'.format(d)


def _pct(part, whole):
    # one decimal, half-even; 0.0% when there is nothing to divide by
    if whole == ZERO:
        return '0.0%'
    return str((part * HUNDRED / whole).quantize(TENTH, rounding=ROUND_HALF_EVEN)) + '%'


# ---------------------------------------------------------------------------
# Revenue by month
# ---------------------------------------------------------------------------

def revenue_by_month(records, year):
    # sort a copy so the report does not depend on the input order
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        if y != year:
            continue
        m = int(r['issued_on'][5:7])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for mm in range(1, 13):
                data[cur][mm] = [0, ZERO, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][m]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['discount'])
        b[3] = b[3] + Decimal(r['tax'])
        b[4] = b[4] + Decimal(r['total'])
        b[5] = b[5] + Decimal(r.get('refunded') or '0')
    out = []
    title = 'REVENUE BY MONTH %d' % year
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-7s  %8s  %14s  %14s  %14s  %14s  %14s  %14s' % (
            'Month', 'Invoices', 'Subtotal', 'Discount', 'Tax', 'Total', 'Refunded', 'Net'))
        sep = '%s  %s  %s  %s  %s  %s  %s  %s' % (
            '-' * 7, '-' * 8, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        tot = [0, ZERO, ZERO, ZERO, ZERO, ZERO]
        for m in range(1, 13):
            b = data[cur][m]
            net = b[4] - b[5]
            out.append('%-7s  %8d  %14s  %14s  %14s  %14s  %14s  %14s' % (
                '%d-%02d' % (year, m), b[0], '{:,.2f}'.format(b[1]), '{:,.2f}'.format(b[2]),
                '{:,.2f}'.format(b[3]), '{:,.2f}'.format(b[4]), '{:,.2f}'.format(b[5]),
                '{:,.2f}'.format(net)))
            tot[0] = tot[0] + b[0]
            tot[1] = tot[1] + b[1]
            tot[2] = tot[2] + b[2]
            tot[3] = tot[3] + b[3]
            tot[4] = tot[4] + b[4]
            tot[5] = tot[5] + b[5]
        out.append(sep)
        out.append('%-7s  %8d  %14s  %14s  %14s  %14s  %14s  %14s' % (
            'TOTAL', tot[0], '{:,.2f}'.format(tot[1]), '{:,.2f}'.format(tot[2]),
            '{:,.2f}'.format(tot[3]), '{:,.2f}'.format(tot[4]), '{:,.2f}'.format(tot[5]),
            '{:,.2f}'.format(tot[4] - tot[5])))
    return '\n'.join(out) + '\n'


def revenue_by_month_csv(records, year):
    # copy of revenue_by_month for the accountants' macro (FIN-388)
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        if y != year:
            continue
        m = int(r['issued_on'][5:7])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for mm in range(1, 13):
                data[cur][mm] = [0, ZERO, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][m]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['discount'])
        b[3] = b[3] + Decimal(r['tax'])
        b[4] = b[4] + Decimal(r['total'])
        b[5] = b[5] + Decimal(r.get('refunded') or '0')
    out = []
    out.append('currency,month,invoices,subtotal,discount,tax,total,refunded,net')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        for m in range(1, 13):
            b = data[cur][m]
            line = cur
            line = line + ',' + '%d-%02d' % (year, m)
            line = line + ',' + str(b[0])
            line = line + ',' + str(b[1].quantize(CENT))
            line = line + ',' + str(b[2].quantize(CENT))
            line = line + ',' + str(b[3].quantize(CENT))
            line = line + ',' + str(b[4].quantize(CENT))
            line = line + ',' + str(b[5].quantize(CENT))
            line = line + ',' + str((b[4] - b[5]).quantize(CENT))
            out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Revenue by quarter
# ---------------------------------------------------------------------------

def revenue_by_quarter(records, year):
    # same as revenue_by_month, by quarter (board pack)
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        if y != year:
            continue
        m = int(r['issued_on'][5:7])
        q = (m - 1) // 3 + 1
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for qq in range(1, 5):
                data[cur][qq] = [0, ZERO, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][q]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['discount'])
        b[3] = b[3] + Decimal(r['tax'])
        b[4] = b[4] + Decimal(r['total'])
        b[5] = b[5] + Decimal(r.get('refunded') or '0')
    out = []
    title = 'REVENUE BY QUARTER %d' % year
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-7s  %8s  %14s  %14s  %14s  %14s  %14s  %14s' % (
            'Quarter', 'Invoices', 'Subtotal', 'Discount', 'Tax', 'Total', 'Refunded', 'Net'))
        sep = '%s  %s  %s  %s  %s  %s  %s  %s' % (
            '-' * 7, '-' * 8, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        tot = [0, ZERO, ZERO, ZERO, ZERO, ZERO]
        for q in range(1, 5):
            b = data[cur][q]
            net = b[4] - b[5]
            out.append('%-7s  %8d  %14s  %14s  %14s  %14s  %14s  %14s' % (
                '%d-Q%d' % (year, q), b[0], '{:,.2f}'.format(b[1]), '{:,.2f}'.format(b[2]),
                '{:,.2f}'.format(b[3]), '{:,.2f}'.format(b[4]), '{:,.2f}'.format(b[5]),
                '{:,.2f}'.format(net)))
            tot[0] = tot[0] + b[0]
            tot[1] = tot[1] + b[1]
            tot[2] = tot[2] + b[2]
            tot[3] = tot[3] + b[3]
            tot[4] = tot[4] + b[4]
            tot[5] = tot[5] + b[5]
        out.append(sep)
        out.append('%-7s  %8d  %14s  %14s  %14s  %14s  %14s  %14s' % (
            'TOTAL', tot[0], '{:,.2f}'.format(tot[1]), '{:,.2f}'.format(tot[2]),
            '{:,.2f}'.format(tot[3]), '{:,.2f}'.format(tot[4]), '{:,.2f}'.format(tot[5]),
            '{:,.2f}'.format(tot[4] - tot[5])))
    return '\n'.join(out) + '\n'


def revenue_by_quarter_csv(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        if y != year:
            continue
        m = int(r['issued_on'][5:7])
        q = (m - 1) // 3 + 1
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for qq in range(1, 5):
                data[cur][qq] = [0, ZERO, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][q]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['discount'])
        b[3] = b[3] + Decimal(r['tax'])
        b[4] = b[4] + Decimal(r['total'])
        b[5] = b[5] + Decimal(r.get('refunded') or '0')
    out = []
    out.append('currency,quarter,invoices,subtotal,discount,tax,total,refunded,net')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        for q in range(1, 5):
            b = data[cur][q]
            line = cur
            line = line + ',' + '%d-Q%d' % (year, q)
            line = line + ',' + str(b[0])
            line = line + ',' + str(b[1].quantize(CENT))
            line = line + ',' + str(b[2].quantize(CENT))
            line = line + ',' + str(b[3].quantize(CENT))
            line = line + ',' + str(b[4].quantize(CENT))
            line = line + ',' + str(b[5].quantize(CENT))
            line = line + ',' + str((b[4] - b[5]).quantize(CENT))
            out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Revenue by country
# ---------------------------------------------------------------------------

def revenue_by_country(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            y = int(r['issued_on'][0:4])
            if y != int(year):
                continue
        cur = r.get('currency') or 'USD'
        c = r['country']
        if cur not in data:
            data[cur] = {}
        if c not in data[cur]:
            data[cur][c] = [0, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][c]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['tax'])
        b[3] = b[3] + Decimal(r['total'])
        b[4] = b[4] + Decimal(r.get('refunded') or '0')
    out = []
    if year is None:
        title = 'REVENUE BY COUNTRY (ALL YEARS)'
    else:
        title = 'REVENUE BY COUNTRY %d' % int(year)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-7s  %-16s  %8s  %14s  %14s  %14s  %14s  %14s' % (
            'Country', 'Name', 'Invoices', 'Subtotal', 'Tax', 'Total', 'Refunded', 'Net'))
        sep = '%s  %s  %s  %s  %s  %s  %s  %s' % (
            '-' * 7, '-' * 16, '-' * 8, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        countries = list(data[cur].keys())
        countries.sort()
        tot = [0, ZERO, ZERO, ZERO, ZERO]
        for c in countries:
            b = data[cur][c]
            name = COUNTRY_NAMES.get(c, c)
            out.append('%-7s  %-16s  %8d  %14s  %14s  %14s  %14s  %14s' % (
                c, name, b[0], '{:,.2f}'.format(b[1]), '{:,.2f}'.format(b[2]),
                '{:,.2f}'.format(b[3]), '{:,.2f}'.format(b[4]), '{:,.2f}'.format(b[3] - b[4])))
            tot[0] = tot[0] + b[0]
            tot[1] = tot[1] + b[1]
            tot[2] = tot[2] + b[2]
            tot[3] = tot[3] + b[3]
            tot[4] = tot[4] + b[4]
        out.append(sep)
        out.append('%-7s  %-16s  %8d  %14s  %14s  %14s  %14s  %14s' % (
            'TOTAL', '', tot[0], '{:,.2f}'.format(tot[1]), '{:,.2f}'.format(tot[2]),
            '{:,.2f}'.format(tot[3]), '{:,.2f}'.format(tot[4]), '{:,.2f}'.format(tot[3] - tot[4])))
    return '\n'.join(out) + '\n'


def revenue_by_country_csv(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            y = int(r['issued_on'][0:4])
            if y != int(year):
                continue
        cur = r.get('currency') or 'USD'
        c = r['country']
        if cur not in data:
            data[cur] = {}
        if c not in data[cur]:
            data[cur][c] = [0, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][c]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['tax'])
        b[3] = b[3] + Decimal(r['total'])
        b[4] = b[4] + Decimal(r.get('refunded') or '0')
    out = []
    out.append('currency,country,invoices,subtotal,tax,total,refunded,net')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        countries = list(data[cur].keys())
        countries.sort()
        for c in countries:
            b = data[cur][c]
            line = cur
            line = line + ',' + c
            line = line + ',' + str(b[0])
            line = line + ',' + str(b[1].quantize(CENT))
            line = line + ',' + str(b[2].quantize(CENT))
            line = line + ',' + str(b[3].quantize(CENT))
            line = line + ',' + str(b[4].quantize(CENT))
            line = line + ',' + str((b[3] - b[4]).quantize(CENT))
            out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Revenue by plan
# ---------------------------------------------------------------------------

def revenue_by_plan(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            y = int(r['issued_on'][0:4])
            if y != int(year):
                continue
        cur = r.get('currency') or 'USD'
        p = r.get('plan')
        if p is None or p == '':
            p = '(none)'
        if cur not in data:
            data[cur] = {}
        if p not in data[cur]:
            data[cur][p] = [0, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][p]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['discount'])
        b[3] = b[3] + Decimal(r['total'])
        b[4] = b[4] + Decimal(r.get('refunded') or '0')
    out = []
    if year is None:
        title = 'REVENUE BY PLAN (ALL YEARS)'
    else:
        title = 'REVENUE BY PLAN %d' % int(year)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-12s  %8s  %14s  %14s  %14s  %14s  %14s' % (
            'Plan', 'Invoices', 'Subtotal', 'Discount', 'Total', 'Net', 'Average'))
        sep = '%s  %s  %s  %s  %s  %s  %s' % (
            '-' * 12, '-' * 8, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        plans = list(data[cur].keys())
        plans.sort()
        tot = [0, ZERO, ZERO, ZERO, ZERO]
        for p in plans:
            b = data[cur][p]
            if b[0] > 0:
                avg = (b[3] / Decimal(b[0])).quantize(CENT, rounding=ROUND_HALF_EVEN)
            else:
                avg = ZERO
            out.append('%-12s  %8d  %14s  %14s  %14s  %14s  %14s' % (
                p, b[0], '{:,.2f}'.format(b[1]), '{:,.2f}'.format(b[2]),
                '{:,.2f}'.format(b[3]), '{:,.2f}'.format(b[3] - b[4]), '{:,.2f}'.format(avg)))
            tot[0] = tot[0] + b[0]
            tot[1] = tot[1] + b[1]
            tot[2] = tot[2] + b[2]
            tot[3] = tot[3] + b[3]
            tot[4] = tot[4] + b[4]
        if tot[0] > 0:
            tavg = (tot[3] / Decimal(tot[0])).quantize(CENT, rounding=ROUND_HALF_EVEN)
        else:
            tavg = ZERO
        out.append(sep)
        out.append('%-12s  %8d  %14s  %14s  %14s  %14s  %14s' % (
            'TOTAL', tot[0], '{:,.2f}'.format(tot[1]), '{:,.2f}'.format(tot[2]),
            '{:,.2f}'.format(tot[3]), '{:,.2f}'.format(tot[3] - tot[4]), '{:,.2f}'.format(tavg)))
    return '\n'.join(out) + '\n'


def revenue_by_plan_csv(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            y = int(r['issued_on'][0:4])
            if y != int(year):
                continue
        cur = r.get('currency') or 'USD'
        p = r.get('plan')
        if p is None or p == '':
            p = '(none)'
        if cur not in data:
            data[cur] = {}
        if p not in data[cur]:
            data[cur][p] = [0, ZERO, ZERO, ZERO, ZERO]
        b = data[cur][p]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['subtotal'])
        b[2] = b[2] + Decimal(r['discount'])
        b[3] = b[3] + Decimal(r['total'])
        b[4] = b[4] + Decimal(r.get('refunded') or '0')
    out = []
    out.append('currency,plan,invoices,subtotal,discount,total,net,average')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        plans = list(data[cur].keys())
        plans.sort()
        for p in plans:
            b = data[cur][p]
            if b[0] > 0:
                avg = (b[3] / Decimal(b[0])).quantize(CENT, rounding=ROUND_HALF_EVEN)
            else:
                avg = ZERO
            line = cur
            line = line + ',' + p
            line = line + ',' + str(b[0])
            line = line + ',' + str(b[1].quantize(CENT))
            line = line + ',' + str(b[2].quantize(CENT))
            line = line + ',' + str(b[3].quantize(CENT))
            line = line + ',' + str((b[3] - b[4]).quantize(CENT))
            line = line + ',' + str(avg.quantize(CENT))
            out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Germany (DE)
# Went live 2019-04 (FIN-230).
# ---------------------------------------------------------------------------

def vat_return_de(records, year, quarter):
    # Umsatzsteuer-Voranmeldung, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.19')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'DE':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 19%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Germany (DE) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Umsatzsteuer-Voranmeldung')
    out.append('Currency: EUR   Standard rate: 19%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_de_csv(records, year, quarter):
    # CSV for the DE filing upload; same numbers as vat_return_de
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'DE':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'DE,EUR'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: France (FR)
# Copied from DE in 2020-02 (FIN-301).
# ---------------------------------------------------------------------------

def vat_return_fr(records, year, quarter):
    # Declaration de TVA (CA3), filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.20')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'FR':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 20%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - France (FR) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Declaration de TVA (CA3)')
    out.append('Currency: EUR   Standard rate: 20%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_fr_csv(records, year, quarter):
    # CSV for the FR filing upload; same numbers as vat_return_fr
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'FR':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'FR,EUR'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Netherlands (NL)
# Copied from FR in 2020-06 (FIN-322).
# ---------------------------------------------------------------------------

def vat_return_nl(records, year, quarter):
    # Omzetbelastingaangifte, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.21')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'NL':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 21%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Netherlands (NL) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Omzetbelastingaangifte')
    out.append('Currency: EUR   Standard rate: 21%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_nl_csv(records, year, quarter):
    # CSV for the NL filing upload; same numbers as vat_return_nl
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'NL':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'NL,EUR'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Spain (ES)
# Copied from NL in 2021-01 (FIN-350).
# ---------------------------------------------------------------------------

def vat_return_es(records, year, quarter):
    # Modelo 303 (IVA), filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.21')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'ES':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 21%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Spain (ES) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Modelo 303 (IVA)')
    out.append('Currency: EUR   Standard rate: 21%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_es_csv(records, year, quarter):
    # CSV for the ES filing upload; same numbers as vat_return_es
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'ES':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'ES,EUR'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Italy (IT)
# Copied from ES in 2021-03 (FIN-361).
# ---------------------------------------------------------------------------

def vat_return_it(records, year, quarter):
    # Liquidazione periodica IVA, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.22')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'IT':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 22%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Italy (IT) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Liquidazione periodica IVA')
    out.append('Currency: EUR   Standard rate: 22%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_it_csv(records, year, quarter):
    # CSV for the IT filing upload; same numbers as vat_return_it
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'IT':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'IT,EUR'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: United Kingdom (GB)
# Making Tax Digital since 2019 (FIN-219).
# ---------------------------------------------------------------------------

def vat_return_gb(records, year, quarter):
    # VAT Return (MTD), filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.20')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'GB':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 20%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - United Kingdom (GB) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('VAT Return (MTD)')
    out.append('Currency: GBP   Standard rate: 20%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_gb_csv(records, year, quarter):
    # CSV for the GB filing upload; same numbers as vat_return_gb
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'GB':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'GB,GBP'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Sweden (SE)
# Copied from GB in 2022-09 (FIN-470).
# ---------------------------------------------------------------------------

def vat_return_se(records, year, quarter):
    # Momsdeklaration, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.25')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'SE':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 25%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Sweden (SE) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Momsdeklaration')
    out.append('Currency: SEK   Standard rate: 25%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_se_csv(records, year, quarter):
    # CSV for the SE filing upload; same numbers as vat_return_se
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'SE':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'SE,SEK'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Japan (JP)
# Yen has no minor unit, hence whole amounts (FIN-402).
# ---------------------------------------------------------------------------

def vat_return_jp(records, year, quarter):
    # Consumption tax return, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.10')
    q = Decimal('1')
    for r in rows:
        if r['country'] != 'JP':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 10%%' % (
                r['number'], '{:,.0f}'.format(tax), '{:,.0f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Japan (JP) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Consumption tax return')
    out.append('Currency: JPY   Standard rate: 10%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.0f}'.format(p[1]), '{:,.0f}'.format(p[2]),
            '{:,.0f}'.format(p[3]), '{:,.0f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.0f}'.format(t1), '{:,.0f}'.format(t2), '{:,.0f}'.format(t3),
        '{:,.0f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.0f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_jp_csv(records, year, quarter):
    # CSV for the JP filing upload; same numbers as vat_return_jp
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('1')
    for r in rows:
        if r['country'] != 'JP':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'JP,JPY'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: Vietnam (VN)
# Copied from JP in 2023-05 (FIN-511).
# ---------------------------------------------------------------------------

def vat_return_vn(records, year, quarter):
    # To khai thue GTGT, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0.10')
    q = Decimal('1')
    for r in rows:
        if r['country'] != 'VN':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 10%%' % (
                r['number'], '{:,.0f}'.format(tax), '{:,.0f}'.format(expected)))
    out = []
    title = 'VAT RETURN - Vietnam (VN) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('To khai thue GTGT')
    out.append('Currency: VND   Standard rate: 10%')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.0f}'.format(p[1]), '{:,.0f}'.format(p[2]),
            '{:,.0f}'.format(p[3]), '{:,.0f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.0f}'.format(t1), '{:,.0f}'.format(t2), '{:,.0f}'.format(t3),
        '{:,.0f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.0f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_vn_csv(records, year, quarter):
    # CSV for the VN filing upload; same numbers as vat_return_vn
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('1')
    for r in rows:
        if r['country'] != 'VN':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'VN,VND'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT return: United States (US)
# Kept for the auditors; no sales tax is collected.
# ---------------------------------------------------------------------------

def vat_return_us(records, year, quarter):
    # Sales tax report, filed quarterly by finance
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    warnings = []
    disc_n = 0
    disc_sum = ZERO
    ref_n = 0
    rate = Decimal('0')
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'US':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        disc = Decimal(r['discount'])
        if disc > ZERO:
            # coupons are taken after tax, so they never reduce the taxable base
            disc_n = disc_n + 1
            disc_sum = disc_sum + disc
        if ref > ZERO:
            ref_n = ref_n + 1
        if ref > ZERO and tot > ZERO:
            # refunded tax is the refund's share of the invoice tax
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
        expected = (sub * rate).quantize(q, rounding=ROUND_HALF_EVEN)
        if expected != tax:
            warnings.append('WARNING: %s tax %s, expected %s at 0%%' % (
                r['number'], '{:,.2f}'.format(tax), '{:,.2f}'.format(expected)))
    out = []
    title = 'VAT RETURN - United States (US) - %d Q%d' % (year, quarter)
    out.append(title)
    out.append('=' * len(title))
    out.append('Sales tax report')
    out.append('Currency: USD   Standard rate: 0%')
    out.append('Sales tax is not collected on US invoices.')
    out.append('')
    out.append('%-7s  %8s  %16s  %16s  %16s  %16s' % (
        'Month', 'Invoices', 'Taxable base', 'Tax collected', 'Tax refunded', 'Net tax due'))
    sep = '%s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16)
    out.append(sep)
    t0 = 0
    t1 = ZERO
    t2 = ZERO
    t3 = ZERO
    for m in months:
        p = per[m]
        out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
            '%d-%02d' % (year, m), p[0], '{:,.2f}'.format(p[1]), '{:,.2f}'.format(p[2]),
            '{:,.2f}'.format(p[3]), '{:,.2f}'.format(p[2] - p[3])))
        t0 = t0 + p[0]
        t1 = t1 + p[1]
        t2 = t2 + p[2]
        t3 = t3 + p[3]
    out.append(sep)
    out.append('%-7s  %8d  %16s  %16s  %16s  %16s' % (
        'TOTAL', t0, '{:,.2f}'.format(t1), '{:,.2f}'.format(t2), '{:,.2f}'.format(t3),
        '{:,.2f}'.format(t2 - t3)))
    out.append('')
    out.append('Discounted invoices: %d (discount %s, not deducted from the taxable base)' % (
        disc_n, '{:,.2f}'.format(disc_sum)))
    out.append('Refunded invoices: %d' % ref_n)
    out.append('')
    if len(warnings) > 0:
        out.append('Rate check: %d warning(s)' % len(warnings))
        for w in warnings:
            out.append(w)
    else:
        out.append('Rate check: OK')
    return '\n'.join(out) + '\n'


def vat_return_us_csv(records, year, quarter):
    # CSV for the US filing upload; same numbers as vat_return_us
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    quarter = int(quarter)
    if quarter < 1 or quarter > 4:
        raise ValueError('quarter must be 1..4, got %r' % quarter)
    first = (quarter - 1) * 3 + 1
    months = [first, first + 1, first + 2]
    per = {}
    for m in months:
        per[m] = [0, ZERO, ZERO, ZERO]
    q = Decimal('0.01')
    for r in rows:
        if r['country'] != 'US':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        if y != year:
            continue
        if m not in months:
            continue
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        p = per[m]
        p[0] = p[0] + 1
        p[1] = p[1] + sub
        p[2] = p[2] + tax
        if ref > ZERO and tot > ZERO:
            p[3] = p[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,month,invoices,taxable_base,tax_collected,tax_refunded,net_tax_due')
    for m in months:
        p = per[m]
        line = 'US,USD'
        line = line + ',' + '%d-%02d' % (year, m)
        line = line + ',' + str(p[0])
        line = line + ',' + str(p[1].quantize(q))
        line = line + ',' + str(p[2].quantize(q))
        line = line + ',' + str(p[3].quantize(q))
        line = line + ',' + str((p[2] - p[3]).quantize(q))
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# VAT dispatch (used by the finance cron job)
# ---------------------------------------------------------------------------

def vat_return(records, country, year, quarter):
    if country == 'DE':
        return vat_return_de(records, year, quarter)
    elif country == 'FR':
        return vat_return_fr(records, year, quarter)
    elif country == 'NL':
        return vat_return_nl(records, year, quarter)
    elif country == 'ES':
        return vat_return_es(records, year, quarter)
    elif country == 'IT':
        return vat_return_it(records, year, quarter)
    elif country == 'GB':
        return vat_return_gb(records, year, quarter)
    elif country == 'SE':
        return vat_return_se(records, year, quarter)
    elif country == 'JP':
        return vat_return_jp(records, year, quarter)
    elif country == 'VN':
        return vat_return_vn(records, year, quarter)
    elif country == 'US':
        return vat_return_us(records, year, quarter)
    else:
        raise ValueError('no VAT return for country %r' % (country,))


def vat_return_csv(records, country, year, quarter):
    if country == 'DE':
        return vat_return_de_csv(records, year, quarter)
    elif country == 'FR':
        return vat_return_fr_csv(records, year, quarter)
    elif country == 'NL':
        return vat_return_nl_csv(records, year, quarter)
    elif country == 'ES':
        return vat_return_es_csv(records, year, quarter)
    elif country == 'IT':
        return vat_return_it_csv(records, year, quarter)
    elif country == 'GB':
        return vat_return_gb_csv(records, year, quarter)
    elif country == 'SE':
        return vat_return_se_csv(records, year, quarter)
    elif country == 'JP':
        return vat_return_jp_csv(records, year, quarter)
    elif country == 'VN':
        return vat_return_vn_csv(records, year, quarter)
    elif country == 'US':
        return vat_return_us_csv(records, year, quarter)
    else:
        raise ValueError('no VAT return for country %r' % (country,))


# ---------------------------------------------------------------------------
# Aging of overdue invoices
# ---------------------------------------------------------------------------

def aging_report(records, as_of):
    # as_of is a datetime.date; collections team runs this every Monday
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if r['status'] != 'past_due':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        d = int(r['issued_on'][8:10])
        issued = datetime.date(y, m, d)
        days = (as_of - issued).days
        if days < 0:
            continue
        cur = r.get('currency') or 'USD'
        cust = r['customer_id']
        amount = Decimal(r['total']) - Decimal(r.get('refunded') or '0')
        if cur not in data:
            data[cur] = {}
        if cust not in data[cur]:
            data[cur][cust] = [ZERO, ZERO, ZERO, ZERO]
        if days <= 30:
            data[cur][cust][0] = data[cur][cust][0] + amount
        elif days <= 60:
            data[cur][cust][1] = data[cur][cust][1] + amount
        elif days <= 90:
            data[cur][cust][2] = data[cur][cust][2] + amount
        else:
            data[cur][cust][3] = data[cur][cust][3] + amount
    out = []
    title = 'AGING REPORT AS OF %s' % as_of.isoformat()
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No overdue invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-10s  %14s  %14s  %14s  %14s  %14s' % (
            'Customer', '0-30', '31-60', '61-90', '90+', 'Total'))
        sep = '%s  %s  %s  %s  %s  %s' % ('-' * 10, '-' * 14, '-' * 14, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        custs = list(data[cur].keys())
        custs.sort()
        t = [ZERO, ZERO, ZERO, ZERO]
        for cust in custs:
            b = data[cur][cust]
            out.append('%-10s  %14s  %14s  %14s  %14s  %14s' % (
                cust, _fmt(b[0]), _fmt(b[1]), _fmt(b[2]), _fmt(b[3]), _fmt(b[0] + b[1] + b[2] + b[3])))
            t[0] = t[0] + b[0]
            t[1] = t[1] + b[1]
            t[2] = t[2] + b[2]
            t[3] = t[3] + b[3]
        out.append(sep)
        out.append('%-10s  %14s  %14s  %14s  %14s  %14s' % (
            'TOTAL', _fmt(t[0]), _fmt(t[1]), _fmt(t[2]), _fmt(t[3]), _fmt(t[0] + t[1] + t[2] + t[3])))
    return '\n'.join(out) + '\n'


def aging_report_csv(records, as_of):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if r['status'] != 'past_due':
            continue
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        d = int(r['issued_on'][8:10])
        issued = datetime.date(y, m, d)
        days = (as_of - issued).days
        if days < 0:
            continue
        cur = r.get('currency') or 'USD'
        cust = r['customer_id']
        amount = Decimal(r['total']) - Decimal(r.get('refunded') or '0')
        if cur not in data:
            data[cur] = {}
        if cust not in data[cur]:
            data[cur][cust] = [ZERO, ZERO, ZERO, ZERO]
        if days <= 30:
            data[cur][cust][0] = data[cur][cust][0] + amount
        elif days <= 60:
            data[cur][cust][1] = data[cur][cust][1] + amount
        elif days <= 90:
            data[cur][cust][2] = data[cur][cust][2] + amount
        else:
            data[cur][cust][3] = data[cur][cust][3] + amount
    out = []
    out.append('currency,customer_id,bucket_0_30,bucket_31_60,bucket_61_90,bucket_90_plus,total')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        custs = list(data[cur].keys())
        custs.sort()
        for cust in custs:
            b = data[cur][cust]
            line = cur + ',' + cust
            line = line + ',' + str(b[0].quantize(CENT))
            line = line + ',' + str(b[1].quantize(CENT))
            line = line + ',' + str(b[2].quantize(CENT))
            line = line + ',' + str(b[3].quantize(CENT))
            line = line + ',' + str((b[0] + b[1] + b[2] + b[3]).quantize(CENT))
            out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Customer statement
# ---------------------------------------------------------------------------

def customer_statement(records, customer_id):
    rows = []
    for r in records:
        if r['customer_id'] == customer_id:
            rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    out = []
    title = 'STATEMENT FOR %s' % customer_id
    out.append(title)
    out.append('=' * len(title))
    if len(rows) == 0:
        out.append('No invoices for this customer.')
        return '\n'.join(out) + '\n'
    curs = []
    for r in rows:
        cur = r.get('currency') or 'USD'
        if cur not in curs:
            curs.append(cur)
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-10s  %-14s  %-18s  %14s  %14s  %14s' % (
            'Date', 'Number', 'Status', 'Charged', 'Refunded', 'Balance'))
        sep = '%s  %s  %s  %s  %s  %s' % ('-' * 10, '-' * 14, '-' * 18, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        charged = ZERO
        refunded = ZERO
        balance = ZERO
        for r in rows:
            if (r.get('currency') or 'USD') != cur:
                continue
            tot = Decimal(r['total'])
            ref = Decimal(r.get('refunded') or '0')
            charged = charged + tot
            refunded = refunded + ref
            if r['status'] == 'past_due':
                balance = balance + tot - ref
            out.append('%-10s  %-14s  %-18s  %14s  %14s  %14s' % (
                r['issued_on'], r['number'], r['status'], _fmt(tot), _fmt(ref), _fmt(balance)))
        out.append(sep)
        out.append('Total charged: %s   Total refunded: %s   Balance due: %s' % (
            _fmt(charged), _fmt(refunded), _fmt(balance)))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Top customers
# ---------------------------------------------------------------------------

def top_customers(records, year=None, limit=10):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    totals = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        cur = r.get('currency') or 'USD'
        cust = r['customer_id']
        net = Decimal(r['total']) - Decimal(r.get('refunded') or '0')
        if cur not in data:
            data[cur] = {}
            totals[cur] = ZERO
        if cust not in data[cur]:
            data[cur][cust] = [0, ZERO]
        data[cur][cust][0] = data[cur][cust][0] + 1
        data[cur][cust][1] = data[cur][cust][1] + net
        totals[cur] = totals[cur] + net
    out = []
    if year is None:
        title = 'TOP CUSTOMERS (ALL YEARS)'
    else:
        title = 'TOP CUSTOMERS %d' % int(year)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-4s  %-10s  %8s  %14s  %7s' % ('Rank', 'Customer', 'Invoices', 'Net revenue', 'Share'))
        out.append('%s  %s  %s  %s  %s' % ('-' * 4, '-' * 10, '-' * 8, '-' * 14, '-' * 7))
        items = []
        for cust in data[cur].keys():
            items.append((-data[cur][cust][1], cust))
        items.sort()
        rank = 0
        for neg, cust in items:
            rank = rank + 1
            if rank > int(limit):
                break
            b = data[cur][cust]
            if totals[cur] == ZERO:
                share = '0.0%'
            else:
                share = str((b[1] * HUNDRED / totals[cur]).quantize(TENTH, rounding=ROUND_HALF_EVEN)) + '%'
            out.append('%4d  %-10s  %8d  %14s  %7s' % (rank, cust, b[0], _fmt(b[1]), share))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Coupon usage
# ---------------------------------------------------------------------------

def coupon_usage(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        code = r.get('coupon_code')
        if code is None or code == '':
            continue
        cur = r.get('currency') or 'USD'
        key = (code, cur)
        if key not in data:
            data[key] = [0, ZERO]
        data[key][0] = data[key][0] + 1
        data[key][1] = data[key][1] + Decimal(r['discount'])
    out = []
    if year is None:
        title = 'COUPON USAGE (ALL YEARS)'
    else:
        title = 'COUPON USAGE %d' % int(year)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No coupons redeemed.')
        return '\n'.join(out) + '\n'
    out.append('%-12s  %-8s  %6s  %14s  %14s' % ('Coupon', 'Currency', 'Uses', 'Discount', 'Average'))
    out.append('%s  %s  %s  %s  %s' % ('-' * 12, '-' * 8, '-' * 6, '-' * 14, '-' * 14))
    keys = list(data.keys())
    keys.sort()
    for key in keys:
        b = data[key]
        avg = (b[1] / Decimal(b[0])).quantize(CENT, rounding=ROUND_HALF_EVEN)
        out.append('%-12s  %-8s  %6d  %14s  %14s' % (key[0], key[1], b[0], _fmt(b[1]), _fmt(avg)))
    return '\n'.join(out) + '\n'


def coupon_usage_csv(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        code = r.get('coupon_code')
        if code is None or code == '':
            continue
        cur = r.get('currency') or 'USD'
        key = (code, cur)
        if key not in data:
            data[key] = [0, ZERO]
        data[key][0] = data[key][0] + 1
        data[key][1] = data[key][1] + Decimal(r['discount'])
    out = []
    out.append('coupon_code,currency,uses,discount,average')
    keys = list(data.keys())
    keys.sort()
    for key in keys:
        b = data[key]
        avg = (b[1] / Decimal(b[0])).quantize(CENT, rounding=ROUND_HALF_EVEN)
        out.append('%s,%s,%d,%s,%s' % (key[0], key[1], b[0], str(b[1].quantize(CENT)), str(avg)))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Refunds
# ---------------------------------------------------------------------------

def refund_report(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    full = []
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        m = int(r['issued_on'][5:7])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for mm in range(1, 13):
                data[cur][mm] = [0, 0, ZERO, ZERO]
        b = data[cur][m]
        ref = Decimal(r.get('refunded') or '0')
        b[0] = b[0] + 1
        if ref > ZERO:
            b[1] = b[1] + 1
        b[2] = b[2] + ref
        b[3] = b[3] + Decimal(r['total'])
        if r['status'] == 'refunded':
            full.append(r['number'])
    out = []
    title = 'REFUNDS %d' % year
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-7s  %8s  %8s  %14s  %11s' % ('Month', 'Invoices', 'Refunded', 'Amount', 'Refund rate'))
        sep = '%s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 8, '-' * 14, '-' * 11)
        out.append(sep)
        t0 = 0
        t1 = 0
        t2 = ZERO
        t3 = ZERO
        for m in range(1, 13):
            b = data[cur][m]
            if b[3] == ZERO:
                rate = '0.0%'
            else:
                rate = str((b[2] * HUNDRED / b[3]).quantize(TENTH, rounding=ROUND_HALF_EVEN)) + '%'
            out.append('%-7s  %8d  %8d  %14s  %11s' % ('%d-%02d' % (year, m), b[0], b[1], _fmt(b[2]), rate))
            t0 = t0 + b[0]
            t1 = t1 + b[1]
            t2 = t2 + b[2]
            t3 = t3 + b[3]
        out.append(sep)
        if t3 == ZERO:
            trate = '0.0%'
        else:
            trate = str((t2 * HUNDRED / t3).quantize(TENTH, rounding=ROUND_HALF_EVEN)) + '%'
        out.append('%-7s  %8d  %8d  %14s  %11s' % ('TOTAL', t0, t1, _fmt(t2), trate))
    out.append('')
    out.append('Fully refunded invoices (%d):' % len(full))
    i = 0
    while i < len(full) and i < 20:
        out.append('  ' + full[i])
        i = i + 1
    if len(full) > 20:
        out.append('  ... and %d more' % (len(full) - 20))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Status summary
# ---------------------------------------------------------------------------

def status_summary(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        cur = r.get('currency') or 'USD'
        st = r['status']
        if cur not in data:
            data[cur] = {}
        if st not in data[cur]:
            data[cur][st] = [0, ZERO, ZERO, ZERO]
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        b = data[cur][st]
        b[0] = b[0] + 1
        b[1] = b[1] + tot
        b[2] = b[2] + ref
        if st == 'past_due':
            b[3] = b[3] + tot - ref
    out = []
    if year is None:
        title = 'STATUS SUMMARY (ALL YEARS)'
    else:
        title = 'STATUS SUMMARY %d' % int(year)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-18s  %8s  %14s  %14s  %14s' % ('Status', 'Invoices', 'Total', 'Refunded', 'Outstanding'))
        sep = '%s  %s  %s  %s  %s' % ('-' * 18, '-' * 8, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        order = []
        for st in STATUS_ORDER:
            if st in data[cur]:
                order.append(st)
        others = []
        for st in data[cur].keys():
            if st not in STATUS_ORDER:
                others.append(st)
        others.sort()
        order = order + others
        t = [0, ZERO, ZERO, ZERO]
        for st in order:
            b = data[cur][st]
            out.append('%-18s  %8d  %14s  %14s  %14s' % (st, b[0], _fmt(b[1]), _fmt(b[2]), _fmt(b[3])))
            t[0] = t[0] + b[0]
            t[1] = t[1] + b[1]
            t[2] = t[2] + b[2]
            t[3] = t[3] + b[3]
        out.append(sep)
        out.append('%-18s  %8d  %14s  %14s  %14s' % ('TOTAL', t[0], _fmt(t[1]), _fmt(t[2]), _fmt(t[3])))
    return '\n'.join(out) + '\n'


def status_summary_csv(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        cur = r.get('currency') or 'USD'
        st = r['status']
        if cur not in data:
            data[cur] = {}
        if st not in data[cur]:
            data[cur][st] = [0, ZERO, ZERO, ZERO]
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        b = data[cur][st]
        b[0] = b[0] + 1
        b[1] = b[1] + tot
        b[2] = b[2] + ref
        if st == 'past_due':
            b[3] = b[3] + tot - ref
    out = []
    out.append('currency,status,invoices,total,refunded,outstanding')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        order = []
        for st in STATUS_ORDER:
            if st in data[cur]:
                order.append(st)
        others = []
        for st in data[cur].keys():
            if st not in STATUS_ORDER:
                others.append(st)
        others.sort()
        order = order + others
        for st in order:
            b = data[cur][st]
            out.append('%s,%s,%d,%s,%s,%s' % (
                cur, st, b[0], str(b[1].quantize(CENT)), str(b[2].quantize(CENT)), str(b[3].quantize(CENT))))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Daily sales
# ---------------------------------------------------------------------------

def daily_sales(records, year, month):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    month = int(month)
    days_in_month = calendar.monthrange(year, month)[1]
    data = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        if int(r['issued_on'][5:7]) != month:
            continue
        d = int(r['issued_on'][8:10])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for dd in range(1, days_in_month + 1):
                data[cur][dd] = [0, ZERO]
        data[cur][d][0] = data[cur][d][0] + 1
        data[cur][d][1] = data[cur][d][1] + Decimal(r['total'])
    out = []
    title = 'DAILY SALES %d-%02d' % (year, month)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-10s  %8s  %14s' % ('Day', 'Invoices', 'Total'))
        sep = '%s  %s  %s' % ('-' * 10, '-' * 8, '-' * 14)
        out.append(sep)
        n = 0
        t = ZERO
        for dd in range(1, days_in_month + 1):
            b = data[cur][dd]
            out.append('%-10s  %8d  %14s' % ('%d-%02d-%02d' % (year, month, dd), b[0], _fmt(b[1])))
            n = n + b[0]
            t = t + b[1]
        out.append(sep)
        out.append('%-10s  %8d  %14s' % ('TOTAL', n, _fmt(t)))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# MRR
# ---------------------------------------------------------------------------

def mrr_report(records, year):
    # MRR here is simply the subtotal billed in the month (finance definition, 2020)
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    custs = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        m = int(r['issued_on'][5:7])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            custs[cur] = {}
            for mm in range(1, 13):
                data[cur][mm] = ZERO
                custs[cur][mm] = {}
        data[cur][m] = data[cur][m] + Decimal(r['subtotal'])
        custs[cur][m][r['customer_id']] = 1
    out = []
    title = 'MRR %d' % year
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-7s  %14s  %9s  %14s  %8s' % ('Month', 'MRR', 'Customers', 'ARPU', 'Growth'))
        out.append('%s  %s  %s  %s  %s' % ('-' * 7, '-' * 14, '-' * 9, '-' * 14, '-' * 8))
        prev = None
        for m in range(1, 13):
            mrr = data[cur][m]
            n = len(custs[cur][m])
            if n > 0:
                arpu = (mrr / Decimal(n)).quantize(CENT, rounding=ROUND_HALF_EVEN)
            else:
                arpu = ZERO
            if prev is None or prev == ZERO:
                growth = 'n/a'
            else:
                g = ((mrr - prev) * HUNDRED / prev).quantize(TENTH, rounding=ROUND_HALF_EVEN)
                if g > ZERO:
                    growth = '+' + str(g) + '%'
                else:
                    growth = str(g) + '%'
            out.append('%-7s  %14s  %9d  %14s  %8s' % ('%d-%02d' % (year, m), _fmt(mrr), n, _fmt(arpu), growth))
            prev = mrr
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Churn
# ---------------------------------------------------------------------------

def churn_report(records, year):
    # a customer churns in month M when billed in M and not billed in M+1
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    billed = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        key = (y, m)
        if key not in billed:
            billed[key] = {}
        billed[key][r['customer_id']] = 1
    out = []
    title = 'CHURN %d' % year
    out.append(title)
    out.append('=' * len(title))
    out.append('%-7s  %8s  %8s  %10s' % ('Month', 'Active', 'Churned', 'Churn rate'))
    sep = '%s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 8, '-' * 10)
    out.append(sep)
    all_custs = {}
    for m in range(1, 13):
        active = billed.get((year, m), {})
        if m == 12:
            nxt = billed.get((year + 1, 1), {})
        else:
            nxt = billed.get((year, m + 1), {})
        churned = 0
        for c in active.keys():
            all_custs[c] = 1
            if c not in nxt:
                churned = churned + 1
        if len(active) == 0:
            rate = '0.0%'
        else:
            rate = str((Decimal(churned) * HUNDRED / Decimal(len(active))).quantize(TENTH, rounding=ROUND_HALF_EVEN)) + '%'
        out.append('%-7s  %8d  %8d  %10s' % ('%d-%02d' % (year, m), len(active), churned, rate))
    out.append(sep)
    out.append('Customers billed in %d: %d' % (year, len(all_custs)))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Discount leakage
# ---------------------------------------------------------------------------

def discount_leakage(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        cur = r.get('currency') or 'USD'
        p = r.get('plan')
        if p is None or p == '':
            p = '(none)'
        if cur not in data:
            data[cur] = {}
        if p not in data[cur]:
            data[cur][p] = [0, 0, ZERO, ZERO]
        disc = Decimal(r['discount'])
        b = data[cur][p]
        b[0] = b[0] + 1
        if disc > ZERO:
            b[1] = b[1] + 1
        b[2] = b[2] + Decimal(r['subtotal'])
        b[3] = b[3] + disc
    out = []
    if year is None:
        title = 'DISCOUNT LEAKAGE (ALL YEARS)'
    else:
        title = 'DISCOUNT LEAKAGE %d' % int(year)
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-12s  %8s  %10s  %14s  %14s  %8s' % (
            'Plan', 'Invoices', 'Discounted', 'Subtotal', 'Discount', 'Leakage'))
        sep = '%s  %s  %s  %s  %s  %s' % ('-' * 12, '-' * 8, '-' * 10, '-' * 14, '-' * 14, '-' * 8)
        out.append(sep)
        plans = list(data[cur].keys())
        plans.sort()
        t = [0, 0, ZERO, ZERO]
        for p in plans:
            b = data[cur][p]
            out.append('%-12s  %8d  %10d  %14s  %14s  %8s' % (p, b[0], b[1], _fmt(b[2]), _fmt(b[3]), _pct(b[3], b[2])))
            t[0] = t[0] + b[0]
            t[1] = t[1] + b[1]
            t[2] = t[2] + b[2]
            t[3] = t[3] + b[3]
        out.append(sep)
        out.append('%-12s  %8d  %10d  %14s  %14s  %8s' % ('TOTAL', t[0], t[1], _fmt(t[2]), _fmt(t[3]), _pct(t[3], t[2])))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Tax summary (all countries)
# ---------------------------------------------------------------------------

def tax_summary(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        cur = r.get('currency') or 'USD'
        key = (r['country'], cur)
        if cur == 'JPY' or cur == 'VND':
            q = Decimal('1')
        else:
            q = CENT
        if key not in data:
            data[key] = [0, ZERO, ZERO, ZERO]
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        b = data[key]
        b[0] = b[0] + 1
        b[1] = b[1] + sub
        b[2] = b[2] + tax
        if ref > ZERO and tot > ZERO:
            b[3] = b[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    title = 'TAX SUMMARY %d' % year
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    out.append('%-7s  %-8s  %8s  %16s  %16s  %16s  %16s' % (
        'Country', 'Currency', 'Invoices', 'Taxable', 'Tax', 'Tax refunded', 'Net tax'))
    out.append('%s  %s  %s  %s  %s  %s  %s' % ('-' * 7, '-' * 8, '-' * 8, '-' * 16, '-' * 16, '-' * 16, '-' * 16))
    keys = list(data.keys())
    keys.sort()
    for key in keys:
        b = data[key]
        out.append('%-7s  %-8s  %8d  %16s  %16s  %16s  %16s' % (
            key[0], key[1], b[0], _fmt(b[1]), _fmt(b[2]), _fmt(b[3]), _fmt(b[2] - b[3])))
    return '\n'.join(out) + '\n'


def tax_summary_csv(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        cur = r.get('currency') or 'USD'
        key = (r['country'], cur)
        if cur == 'JPY' or cur == 'VND':
            q = Decimal('1')
        else:
            q = CENT
        if key not in data:
            data[key] = [0, ZERO, ZERO, ZERO]
        sub = Decimal(r['subtotal'])
        tax = Decimal(r['tax'])
        tot = Decimal(r['total'])
        ref = Decimal(r.get('refunded') or '0')
        b = data[key]
        b[0] = b[0] + 1
        b[1] = b[1] + sub
        b[2] = b[2] + tax
        if ref > ZERO and tot > ZERO:
            b[3] = b[3] + (ref * tax / tot).quantize(q, rounding=ROUND_HALF_EVEN)
    out = []
    out.append('country,currency,invoices,taxable,tax,tax_refunded,net_tax')
    keys = list(data.keys())
    keys.sort()
    for key in keys:
        b = data[key]
        out.append('%s,%s,%d,%s,%s,%s,%s' % (
            key[0], key[1], b[0], str(b[1].quantize(CENT)), str(b[2].quantize(CENT)),
            str(b[3].quantize(CENT)), str((b[2] - b[3]).quantize(CENT))))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# CSV variants added for the data warehouse load (FIN-540, 2023)
# Each is a copy of the text report above it with the formatting swapped.
# ---------------------------------------------------------------------------

def daily_sales_csv(records, year, month):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    month = int(month)
    days_in_month = calendar.monthrange(year, month)[1]
    data = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        if int(r['issued_on'][5:7]) != month:
            continue
        d = int(r['issued_on'][8:10])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for dd in range(1, days_in_month + 1):
                data[cur][dd] = [0, ZERO]
        data[cur][d][0] = data[cur][d][0] + 1
        data[cur][d][1] = data[cur][d][1] + Decimal(r['total'])
    out = []
    out.append('currency,day,invoices,total')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        for dd in range(1, days_in_month + 1):
            b = data[cur][dd]
            out.append('%s,%d-%02d-%02d,%d,%s' % (cur, year, month, dd, b[0], str(b[1].quantize(CENT))))
    return '\n'.join(out) + '\n'


def mrr_report_csv(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    custs = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        m = int(r['issued_on'][5:7])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            custs[cur] = {}
            for mm in range(1, 13):
                data[cur][mm] = ZERO
                custs[cur][mm] = {}
        data[cur][m] = data[cur][m] + Decimal(r['subtotal'])
        custs[cur][m][r['customer_id']] = 1
    out = []
    out.append('currency,month,mrr,customers,arpu,growth_pct')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        prev = None
        for m in range(1, 13):
            mrr = data[cur][m]
            n = len(custs[cur][m])
            if n > 0:
                arpu = (mrr / Decimal(n)).quantize(CENT, rounding=ROUND_HALF_EVEN)
            else:
                arpu = ZERO
            if prev is None or prev == ZERO:
                growth = ''
            else:
                growth = str(((mrr - prev) * HUNDRED / prev).quantize(TENTH, rounding=ROUND_HALF_EVEN))
            out.append('%s,%d-%02d,%s,%d,%s,%s' % (cur, year, m, str(mrr.quantize(CENT)), n, str(arpu.quantize(CENT)), growth))
            prev = mrr
    return '\n'.join(out) + '\n'


def churn_report_csv(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    billed = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        key = (y, m)
        if key not in billed:
            billed[key] = {}
        billed[key][r['customer_id']] = 1
    out = []
    out.append('month,active,churned,churn_rate_pct')
    for m in range(1, 13):
        active = billed.get((year, m), {})
        if m == 12:
            nxt = billed.get((year + 1, 1), {})
        else:
            nxt = billed.get((year, m + 1), {})
        churned = 0
        for c in active.keys():
            if c not in nxt:
                churned = churned + 1
        if len(active) == 0:
            rate = '0.0'
        else:
            rate = str((Decimal(churned) * HUNDRED / Decimal(len(active))).quantize(TENTH, rounding=ROUND_HALF_EVEN))
        out.append('%d-%02d,%d,%d,%s' % (year, m, len(active), churned, rate))
    return '\n'.join(out) + '\n'


def discount_leakage_csv(records, year=None):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        cur = r.get('currency') or 'USD'
        p = r.get('plan')
        if p is None or p == '':
            p = '(none)'
        if cur not in data:
            data[cur] = {}
        if p not in data[cur]:
            data[cur][p] = [0, 0, ZERO, ZERO]
        disc = Decimal(r['discount'])
        b = data[cur][p]
        b[0] = b[0] + 1
        if disc > ZERO:
            b[1] = b[1] + 1
        b[2] = b[2] + Decimal(r['subtotal'])
        b[3] = b[3] + disc
    out = []
    out.append('currency,plan,invoices,discounted,subtotal,discount,leakage_pct')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        plans = list(data[cur].keys())
        plans.sort()
        for p in plans:
            b = data[cur][p]
            if b[2] == ZERO:
                leak = '0.0'
            else:
                leak = str((b[3] * HUNDRED / b[2]).quantize(TENTH, rounding=ROUND_HALF_EVEN))
            out.append('%s,%s,%d,%d,%s,%s,%s' % (cur, p, b[0], b[1], str(b[2].quantize(CENT)), str(b[3].quantize(CENT)), leak))
    return '\n'.join(out) + '\n'


def top_customers_csv(records, year=None, limit=10):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    data = {}
    totals = {}
    for r in rows:
        if year is not None:
            if int(r['issued_on'][0:4]) != int(year):
                continue
        cur = r.get('currency') or 'USD'
        cust = r['customer_id']
        net = Decimal(r['total']) - Decimal(r.get('refunded') or '0')
        if cur not in data:
            data[cur] = {}
            totals[cur] = ZERO
        if cust not in data[cur]:
            data[cur][cust] = [0, ZERO]
        data[cur][cust][0] = data[cur][cust][0] + 1
        data[cur][cust][1] = data[cur][cust][1] + net
        totals[cur] = totals[cur] + net
    out = []
    out.append('currency,rank,customer_id,invoices,net_revenue,share_pct')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        items = []
        for cust in data[cur].keys():
            items.append((-data[cur][cust][1], cust))
        items.sort()
        rank = 0
        for neg, cust in items:
            rank = rank + 1
            if rank > int(limit):
                break
            b = data[cur][cust]
            if totals[cur] == ZERO:
                share = '0.0'
            else:
                share = str((b[1] * HUNDRED / totals[cur]).quantize(TENTH, rounding=ROUND_HALF_EVEN))
            out.append('%s,%d,%s,%d,%s,%s' % (cur, rank, cust, b[0], str(b[1].quantize(CENT)), share))
    return '\n'.join(out) + '\n'


def refund_report_csv(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    data = {}
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        m = int(r['issued_on'][5:7])
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for mm in range(1, 13):
                data[cur][mm] = [0, 0, ZERO, ZERO]
        b = data[cur][m]
        ref = Decimal(r.get('refunded') or '0')
        b[0] = b[0] + 1
        if ref > ZERO:
            b[1] = b[1] + 1
        b[2] = b[2] + ref
        b[3] = b[3] + Decimal(r['total'])
    out = []
    out.append('currency,month,invoices,refunded_invoices,refunded_amount,refund_rate_pct')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        for m in range(1, 13):
            b = data[cur][m]
            if b[3] == ZERO:
                rate = '0.0'
            else:
                rate = str((b[2] * HUNDRED / b[3]).quantize(TENTH, rounding=ROUND_HALF_EVEN))
            out.append('%s,%d-%02d,%d,%d,%s,%s' % (cur, year, m, b[0], b[1], str(b[2].quantize(CENT)), rate))
    return '\n'.join(out) + '\n'


def customer_statement_csv(records, customer_id):
    rows = []
    for r in records:
        if r['customer_id'] == customer_id:
            rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    out = []
    out.append('currency,date,number,status,charged,refunded,balance')
    curs = []
    for r in rows:
        cur = r.get('currency') or 'USD'
        if cur not in curs:
            curs.append(cur)
    curs.sort()
    for cur in curs:
        balance = ZERO
        for r in rows:
            if (r.get('currency') or 'USD') != cur:
                continue
            tot = Decimal(r['total'])
            ref = Decimal(r.get('refunded') or '0')
            if r['status'] == 'past_due':
                balance = balance + tot - ref
            out.append('%s,%s,%s,%s,%s,%s,%s' % (
                cur, r['issued_on'], r['number'], r['status'], str(tot.quantize(CENT)),
                str(ref.quantize(CENT)), str(balance.quantize(CENT))))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Invoice register (auditors)
# ---------------------------------------------------------------------------

def invoice_register(records, year, month):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    month = int(month)
    picked = []
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        if int(r['issued_on'][5:7]) != month:
            continue
        picked.append(r)
    out = []
    title = 'INVOICE REGISTER %d-%02d' % (year, month)
    out.append(title)
    out.append('=' * len(title))
    if len(picked) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    out.append('%-10s  %-14s  %-10s  %-7s  %-8s  %-12s  %14s  %14s  %14s  %-18s' % (
        'Date', 'Number', 'Customer', 'Country', 'Currency', 'Coupon', 'Subtotal', 'Tax', 'Total', 'Status'))
    sep = '%s  %s  %s  %s  %s  %s  %s  %s  %s  %s' % (
        '-' * 10, '-' * 14, '-' * 10, '-' * 7, '-' * 8, '-' * 12, '-' * 14, '-' * 14, '-' * 14, '-' * 18)
    out.append(sep)
    counts = {}
    for r in picked:
        code = r.get('coupon_code')
        if code is None:
            code = ''
        out.append('%-10s  %-14s  %-10s  %-7s  %-8s  %-12s  %14s  %14s  %14s  %-18s' % (
            r['issued_on'], r['number'], r['customer_id'], r['country'], r.get('currency') or 'USD', code,
            _fmt(Decimal(r['subtotal'])), _fmt(Decimal(r['tax'])), _fmt(Decimal(r['total'])), r['status']))
        cur = r.get('currency') or 'USD'
        if cur not in counts:
            counts[cur] = [0, ZERO]
        counts[cur][0] = counts[cur][0] + 1
        counts[cur][1] = counts[cur][1] + Decimal(r['total'])
    out.append(sep)
    curs = list(counts.keys())
    curs.sort()
    for cur in curs:
        out.append('%s: %d invoice(s), total %s' % (cur, counts[cur][0], _fmt(counts[cur][1])))
    return '\n'.join(out) + '\n'


def invoice_register_csv(records, year, month):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    month = int(month)
    out = []
    out.append('issued_on,number,customer_id,country,currency,coupon_code,subtotal,discount,tax,total,refunded,status')
    for r in rows:
        if int(r['issued_on'][0:4]) != year:
            continue
        if int(r['issued_on'][5:7]) != month:
            continue
        code = r.get('coupon_code')
        if code is None:
            code = ''
        line = r['issued_on']
        line = line + ',' + r['number']
        line = line + ',' + r['customer_id']
        line = line + ',' + r['country']
        line = line + ',' + (r.get('currency') or 'USD')
        line = line + ',' + code
        line = line + ',' + str(Decimal(r['subtotal']).quantize(CENT))
        line = line + ',' + str(Decimal(r['discount']).quantize(CENT))
        line = line + ',' + str(Decimal(r['tax']).quantize(CENT))
        line = line + ',' + str(Decimal(r['total']).quantize(CENT))
        line = line + ',' + str(Decimal(r.get('refunded') or '0').quantize(CENT))
        line = line + ',' + r['status']
        out.append(line)
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Month-end close pack: what finance prints on the first working day
# ---------------------------------------------------------------------------

def monthly_close_pack(records, year, month):
    year = int(year)
    month = int(month)
    parts = []
    parts.append(invoice_register(records, year, month))
    parts.append(daily_sales(records, year, month))
    parts.append(status_summary(records, year))
    parts.append(coupon_usage(records, year))
    if month in (3, 6, 9, 12):
        q = month // 3
        for cc in ['DE', 'FR', 'NL', 'ES', 'IT', 'GB', 'SE', 'JP', 'VN', 'US']:
            parts.append(vat_return(records, cc, year, q))
    head = 'MONTH-END CLOSE PACK %d-%02d' % (year, month)
    out = head + '\n' + '#' * len(head) + '\n'
    i = 0
    for p in parts:
        i = i + 1
        out = out + '\n' + ('-' * 30) + (' page %d ' % i) + ('-' * 30) + '\n' + p
    return out


# ---------------------------------------------------------------------------
# Revenue by ISO week (growth team, 2024)
# ---------------------------------------------------------------------------

def revenue_by_week(records, year):
    # ISO weeks: an invoice dated 2025-12-29 belongs to 2026-W01
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    weeks = datetime.date(year, 12, 28).isocalendar()[1]
    data = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        d = int(r['issued_on'][8:10])
        iso = datetime.date(y, m, d).isocalendar()
        if iso[0] != year:
            continue
        w = iso[1]
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for ww in range(1, weeks + 1):
                data[cur][ww] = [0, ZERO, ZERO]
        b = data[cur][w]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['total'])
        b[2] = b[2] + Decimal(r.get('refunded') or '0')
    out = []
    title = 'REVENUE BY WEEK %d' % year
    out.append(title)
    out.append('=' * len(title))
    if len(data) == 0:
        out.append('No invoices.')
        return '\n'.join(out) + '\n'
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        out.append('')
        out.append('Currency: %s' % cur)
        out.append('%-8s  %8s  %14s  %14s  %14s' % ('Week', 'Invoices', 'Total', 'Refunded', 'Net'))
        sep = '%s  %s  %s  %s  %s' % ('-' * 8, '-' * 8, '-' * 14, '-' * 14, '-' * 14)
        out.append(sep)
        t = [0, ZERO, ZERO]
        for ww in range(1, weeks + 1):
            b = data[cur][ww]
            out.append('%-8s  %8d  %14s  %14s  %14s' % (
                '%d-W%02d' % (year, ww), b[0], _fmt(b[1]), _fmt(b[2]), _fmt(b[1] - b[2])))
            t[0] = t[0] + b[0]
            t[1] = t[1] + b[1]
            t[2] = t[2] + b[2]
        out.append(sep)
        out.append('%-8s  %8d  %14s  %14s  %14s' % ('TOTAL', t[0], _fmt(t[1]), _fmt(t[2]), _fmt(t[1] - t[2])))
    return '\n'.join(out) + '\n'


def revenue_by_week_csv(records, year):
    rows = []
    for r in records:
        rows.append(r)
    rows.sort(key=lambda r: (r['issued_on'], r['number']))
    year = int(year)
    weeks = datetime.date(year, 12, 28).isocalendar()[1]
    data = {}
    for r in rows:
        y = int(r['issued_on'][0:4])
        m = int(r['issued_on'][5:7])
        d = int(r['issued_on'][8:10])
        iso = datetime.date(y, m, d).isocalendar()
        if iso[0] != year:
            continue
        w = iso[1]
        cur = r.get('currency') or 'USD'
        if cur not in data:
            data[cur] = {}
            for ww in range(1, weeks + 1):
                data[cur][ww] = [0, ZERO, ZERO]
        b = data[cur][w]
        b[0] = b[0] + 1
        b[1] = b[1] + Decimal(r['total'])
        b[2] = b[2] + Decimal(r.get('refunded') or '0')
    out = []
    out.append('currency,week,invoices,total,refunded,net')
    curs = list(data.keys())
    curs.sort()
    for cur in curs:
        for ww in range(1, weeks + 1):
            b = data[cur][ww]
            out.append('%s,%d-W%02d,%d,%s,%s,%s' % (
                cur, year, ww, b[0], str(b[1].quantize(CENT)), str(b[2].quantize(CENT)),
                str((b[1] - b[2]).quantize(CENT))))
    return '\n'.join(out) + '\n'


# ---------------------------------------------------------------------------
# Old helpers kept "just in case" (unused since the 2021 move to Decimal)
# ---------------------------------------------------------------------------

def _parse_date_old(s):
    # accepted 'DD/MM/YYYY' from the PHP exports; nothing calls this any more
    if '/' in s:
        parts = s.split('/')
        return datetime.date(int(parts[2]), int(parts[1]), int(parts[0]))
    return datetime.date(int(s[0:4]), int(s[5:7]), int(s[8:10]))


def _money_old(x):
    # floats! do not use (FIN-290)
    return '%.2f' % float(x)


def _sum_field(rows, field):
    total = ZERO
    for r in rows:
        total = total + Decimal(r[field])
    return total


# ---------------------------------------------------------------------------
# Command line (finance cron): python legacy_reports.py <report> <file.jsonl> [args]
# ---------------------------------------------------------------------------

def _load_jsonl(path):
    import json
    rows = []
    f = open(path)
    try:
        for line in f:
            line = line.strip()
            if line == '':
                continue
            rows.append(json.loads(line))
    finally:
        f.close()
    return rows


def _main(argv):
    if len(argv) < 3:
        print('usage: legacy_reports.py <report> <file.jsonl> [args...]')
        return 2
    name = argv[1]
    rows = _load_jsonl(argv[2])
    args = argv[3:]
    if name == 'revenue_by_month':
        print(revenue_by_month(rows, int(args[0])), end='')
    elif name == 'revenue_by_quarter':
        print(revenue_by_quarter(rows, int(args[0])), end='')
    elif name == 'revenue_by_week':
        print(revenue_by_week(rows, int(args[0])), end='')
    elif name == 'revenue_by_country':
        if len(args) > 0:
            print(revenue_by_country(rows, int(args[0])), end='')
        else:
            print(revenue_by_country(rows), end='')
    elif name == 'revenue_by_plan':
        if len(args) > 0:
            print(revenue_by_plan(rows, int(args[0])), end='')
        else:
            print(revenue_by_plan(rows), end='')
    elif name == 'vat_return':
        print(vat_return(rows, args[0], int(args[1]), int(args[2])), end='')
    elif name == 'aging_report':
        y, m, d = args[0].split('-')
        print(aging_report(rows, datetime.date(int(y), int(m), int(d))), end='')
    elif name == 'customer_statement':
        print(customer_statement(rows, args[0]), end='')
    elif name == 'top_customers':
        print(top_customers(rows, int(args[0]) if len(args) > 0 else None), end='')
    elif name == 'coupon_usage':
        print(coupon_usage(rows, int(args[0]) if len(args) > 0 else None), end='')
    elif name == 'refund_report':
        print(refund_report(rows, int(args[0])), end='')
    elif name == 'status_summary':
        print(status_summary(rows, int(args[0]) if len(args) > 0 else None), end='')
    elif name == 'daily_sales':
        print(daily_sales(rows, int(args[0]), int(args[1])), end='')
    elif name == 'mrr_report':
        print(mrr_report(rows, int(args[0])), end='')
    elif name == 'churn_report':
        print(churn_report(rows, int(args[0])), end='')
    elif name == 'discount_leakage':
        print(discount_leakage(rows, int(args[0]) if len(args) > 0 else None), end='')
    elif name == 'tax_summary':
        print(tax_summary(rows, int(args[0])), end='')
    elif name == 'invoice_register':
        print(invoice_register(rows, int(args[0]), int(args[1])), end='')
    elif name == 'monthly_close_pack':
        print(monthly_close_pack(rows, int(args[0]), int(args[1])), end='')
    else:
        print('unknown report %s' % name)
        return 2
    return 0


if __name__ == '__main__':
    import sys
    sys.exit(_main(sys.argv))

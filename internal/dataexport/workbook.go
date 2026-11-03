// Package dataexport writes bounded, dependency-free spreadsheet downloads.
package dataexport

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

type Sheet struct {
	Name    string
	Headers []string
	Rows    [][]any
}

func cellText(v any) string { return fmt.Sprint(v) }
func safeCSV(s string) string {
	trim := strings.TrimLeftFunc(s, func(r rune) bool { return unicode.IsSpace(r) || unicode.IsControl(r) || r == 0xfeff })
	if len(trim) > 0 && strings.ContainsRune("=+-@", rune(trim[0])) {
		return "'" + s
	}
	return s
}
func CSV(sheet Sheet) ([]byte, error) {
	var out bytes.Buffer
	out.WriteString("\ufeff")
	w := csv.NewWriter(&out)
	w.Comma = ';'
	w.UseCRLF = true
	if err := w.Write(sheet.Headers); err != nil {
		return nil, err
	}
	for _, row := range sheet.Rows {
		cells := []string{}
		for _, v := range row {
			switch v.(type) {
			case int, int64, float64:
				cells = append(cells, cellText(v))
			default:
				cells = append(cells, safeCSV(cellText(v)))
			}
		}
		if err := w.Write(cells); err != nil {
			return nil, err
		}
	}
	w.Flush()
	return out.Bytes(), w.Error()
}
func escape(s string) string {
	var b bytes.Buffer
	s = strings.Map(func(r rune) rune {
		if r < 32 && r != '\t' && r != '\n' && r != '\r' {
			return -1
		}
		return r
	}, s)
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func col(n int) string {
	s := ""
	for n++; n > 0; n = (n - 1) / 26 {
		s = string(rune('A'+(n-1)%26)) + s
	}
	return s
}
func XLSX(sheets []Sheet) ([]byte, error) {
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	write := func(name, body string) error {
		f, err := z.Create(name)
		if err != nil {
			return err
		}
		_, err = f.Write([]byte(body))
		return err
	}
	types := `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>`
	book := `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>`
	rels := `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
	for i, sheet := range sheets {
		num := strconv.Itoa(i + 1)
		types += `<Override PartName="/xl/worksheets/sheet` + num + `.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
		book += `<sheet name="` + escape(sheet.Name) + `" sheetId="` + num + `" r:id="rId` + num + `"/>`
		rels += `<Relationship Id="rId` + num + `" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet` + num + `.xml"/>`
		var body strings.Builder
		body.WriteString(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>`)
		for n := range sheet.Headers {
			body.WriteString(fmt.Sprintf(`<col min="%d" max="%d" width="24" customWidth="1"/>`, n+1, n+1))
		}
		body.WriteString(`</cols><sheetData>`)
		all := [][]any{{}}
		for _, h := range sheet.Headers {
			all[0] = append(all[0], h)
		}
		all = append(all, sheet.Rows...)
		for rn, row := range all {
			body.WriteString(fmt.Sprintf(`<row r="%d">`, rn+1))
			for cn, v := range row {
				ref := col(cn) + strconv.Itoa(rn+1)
				style := "0"
				if rn == 0 {
					style = "1"
				}
				switch v.(type) {
				case int, int64, float64:
					body.WriteString(`<c r="` + ref + `" s="` + style + `"><v>` + escape(cellText(v)) + `</v></c>`)
				default:
					body.WriteString(`<c r="` + ref + `" s="` + style + `" t="inlineStr"><is><t xml:space="preserve">` + escape(cellText(v)) + `</t></is></c>`)
				}
			}
			body.WriteString(`</row>`)
		}
		body.WriteString(`</sheetData>`)
		if len(sheet.Headers) > 0 {
			body.WriteString(fmt.Sprintf(`<autoFilter ref="A1:%s%d"/>`, col(len(sheet.Headers)-1), len(all)))
		}
		body.WriteString(`</worksheet>`)
		if err := write("xl/worksheets/sheet"+num+".xml", body.String()); err != nil {
			return nil, err
		}
	}
	types += `</Types>`
	book += `</sheets></workbook>`
	rels += `<Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`
	for _, file := range [][2]string{{"[Content_Types].xml", types}, {"_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`}, {"xl/workbook.xml", book}, {"xl/_rels/workbook.xml.rels", rels}, {"xl/styles.xml", `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`}} {
		if err := write(file[0], file[1]); err != nil {
			return nil, err
		}
	}
	if err := z.Close(); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

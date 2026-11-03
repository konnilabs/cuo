package dataexport

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"io"
	"strings"
	"testing"
)

func TestDownloadsPreserveUnicodeAndPreventSpreadsheetFormulaExecution(t *testing.T) {
	sheet := Sheet{Name: "Läufe", Headers: []string{"Name", "Wert"}, Rows: [][]any{{"\t=HYPERLINK(\"bad\")", -12}, {"Änderung <&>\nZeile", 2}, {"@SUM(1)", "+2"}}}
	data, err := CSV(sheet)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(data, []byte("\ufeff")) {
		t.Fatal("UTF8 BOM missing")
	}
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(data), "\ufeff")))
	r.Comma = ';'
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if rows[1][0][0] != '\'' || rows[1][1] != "-12" || rows[3][1] != "'+2" || !strings.Contains(rows[2][0], "Änderung") {
		t.Fatal(rows)
	}
	data, err = XLSX([]Sheet{sheet, {Name: "Exportinfo", Headers: []string{"Zeit"}}})
	if err != nil {
		t.Fatal(err)
	}
	z, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	found := map[string]string{}
	for _, f := range z.File {
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		r.Close()
		found[f.Name] = string(b)
		d := xml.NewDecoder(bytes.NewReader(b))
		for {
			_, e := d.Token()
			if e == io.EOF {
				break
			}
			if e != nil {
				t.Fatalf("invalid XML %s: %v", f.Name, e)
			}
		}
	}
	for _, name := range []string{"[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml"} {
		if found[name] == "" {
			t.Fatal("missing", name)
		}
	}
	xmlText := found["xl/worksheets/sheet1.xml"]
	if strings.Contains(xmlText, "<f>") || !strings.Contains(xmlText, "t=\"inlineStr\"") || !strings.Contains(xmlText, "<v>-12</v>") || !strings.Contains(xmlText, "state=\"frozen\"") || !strings.Contains(xmlText, "autoFilter") {
		t.Fatal(xmlText)
	}
}

import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.Driver;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * JPA Power Tools JDBC bridge.
 *
 * Reads one JSON request per line from stdin and writes one JSON response per line to stdout:
 *   {"id":1,"op":"connect","url":"jdbc:...","user":"u","password":"p","driverClass":"..."}
 *   {"id":1,"ok":true,"result":{...}}  or  {"id":1,"ok":false,"error":"..."}
 *
 * Only DatabaseMetaData is used: the bridge never executes SQL text received from the extension.
 * Run with: java -cp driver.jar JdbcBridge.java   (Java 11+ single-file source launch)
 */
public final class JdbcBridge {
    private static PrintStream out;
    private static Connection conn;
    private static boolean useCatalogs;

    public static void main(String[] args) throws Exception {
        // Drivers sometimes print to stdout; keep the protocol channel clean.
        out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        System.setOut(System.err);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            Object id = null;
            try {
                @SuppressWarnings("unchecked")
                Map<String, Object> req = (Map<String, Object>) new Json(line).parse();
                id = req.get("id");
                Object result = handle(req);
                respond(id, true, result, null);
                if ("close".equals(req.get("op"))) {
                    break;
                }
            } catch (Throwable t) {
                respond(id, false, null, describe(t));
            }
        }
        if (conn != null) {
            try { conn.close(); } catch (SQLException ignored) { }
        }
    }

    private static String describe(Throwable t) {
        Throwable root = t;
        while (root.getCause() != null && root.getCause() != root) {
            root = root.getCause();
        }
        String msg = t.getMessage() != null ? t.getMessage() : t.toString();
        if (root != t && root.getMessage() != null && !msg.contains(root.getMessage())) {
            msg += " (" + root.getMessage() + ")";
        }
        if (t instanceof SQLException && ((SQLException) t).getSQLState() != null) {
            msg = "[" + ((SQLException) t).getSQLState() + "] " + msg;
        }
        return msg;
    }

    private static void respond(Object id, boolean ok, Object result, String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("ok", ok);
        if (ok) {
            m.put("result", result);
        } else {
            m.put("error", error);
        }
        StringBuilder sb = new StringBuilder();
        Json.write(m, sb);
        synchronized (out) {
            out.println(sb);
        }
    }

    private static Object handle(Map<String, Object> req) throws Exception {
        String op = (String) req.get("op");
        switch (op) {
            case "connect": return connect(req);
            case "schemas": return schemas();
            case "tables": return tables((String) req.get("schema"));
            case "columns": return columns((String) req.get("schema"));
            case "keys": return keys((String) req.get("schema"), stringList(req.get("tables")));
            case "close": return null;
            default: throw new IllegalArgumentException("Unknown op: " + op);
        }
    }

    @SuppressWarnings("unchecked")
    private static List<String> stringList(Object o) {
        List<String> out = new ArrayList<>();
        if (o instanceof List) {
            for (Object x : (List<Object>) o) {
                out.add(String.valueOf(x));
            }
        }
        return out;
    }

    private static Map<String, Object> connect(Map<String, Object> req) throws Exception {
        String url = (String) req.get("url");
        String driverClass = (String) req.get("driverClass");
        Properties props = new Properties();
        if (req.get("user") != null && !((String) req.get("user")).isEmpty()) {
            props.setProperty("user", (String) req.get("user"));
        }
        if (req.get("password") != null) {
            props.setProperty("password", (String) req.get("password"));
        }
        DriverManager.setLoginTimeout(15);
        if (driverClass != null && !driverClass.isEmpty()) {
            Driver driver = (Driver) Class.forName(driverClass).getDeclaredConstructor().newInstance();
            conn = driver.connect(url, props);
            if (conn == null) {
                throw new SQLException("Driver " + driverClass + " does not accept URL " + url);
            }
        } else {
            conn = DriverManager.getConnection(url, props);
        }
        try { conn.setReadOnly(true); } catch (SQLException ignored) { /* e.g. SQLite after connect */ }
        DatabaseMetaData md = conn.getMetaData();
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("product", md.getDatabaseProductName());
        r.put("version", md.getDatabaseProductVersion());
        String schema = null;
        try { schema = conn.getSchema(); } catch (Throwable ignored) { }
        String catalog = null;
        try { catalog = conn.getCatalog(); } catch (Throwable ignored) { }
        r.put("schema", schema);
        r.put("catalog", catalog);
        r.put("userName", md.getUserName());
        return r;
    }

    private static List<String> schemas() throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        List<String> names = new ArrayList<>();
        try (ResultSet rs = md.getSchemas()) {
            while (rs.next()) {
                names.add(rs.getString("TABLE_SCHEM"));
            }
        }
        useCatalogs = false;
        if (names.isEmpty()) {
            try (ResultSet rs = md.getCatalogs()) {
                while (rs.next()) {
                    names.add(rs.getString("TABLE_CAT"));
                }
            }
            useCatalogs = !names.isEmpty();
        }
        if (names.isEmpty()) {
            names.add("");
        }
        return names;
    }

    private static String catalogFor(String schema) {
        return useCatalogs && schema != null && !schema.isEmpty() ? schema : null;
    }

    private static String schemaFor(String schema) {
        return useCatalogs || schema == null || schema.isEmpty() ? null : schema;
    }

    private static String pattern(String schema) throws SQLException {
        String s = schemaFor(schema);
        if (s == null) {
            return null;
        }
        String esc = conn.getMetaData().getSearchStringEscape();
        if (esc == null || esc.isEmpty()) {
            return s;
        }
        return s.replace(esc, esc + esc).replace("_", esc + "_").replace("%", esc + "%");
    }

    private static List<Map<String, Object>> tables(String schema) throws SQLException {
        List<Map<String, Object>> rows = new ArrayList<>();
        try (ResultSet rs = conn.getMetaData().getTables(catalogFor(schema), pattern(schema), "%", null)) {
            while (rs.next()) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("name", rs.getString("TABLE_NAME"));
                r.put("type", rs.getString("TABLE_TYPE"));
                r.put("comment", rs.getString("REMARKS"));
                rows.add(r);
            }
        }
        return rows;
    }

    private static List<Map<String, Object>> columns(String schema) throws SQLException {
        List<Map<String, Object>> rows = new ArrayList<>();
        try (ResultSet rs = conn.getMetaData().getColumns(catalogFor(schema), pattern(schema), "%", "%")) {
            while (rs.next()) {
                Map<String, Object> r = new LinkedHashMap<>();
                r.put("table", rs.getString("TABLE_NAME"));
                r.put("name", rs.getString("COLUMN_NAME"));
                r.put("jdbcType", rs.getInt("DATA_TYPE"));
                r.put("typeName", rs.getString("TYPE_NAME"));
                int size = rs.getInt("COLUMN_SIZE");
                r.put("size", rs.wasNull() ? null : size);
                int digits = rs.getInt("DECIMAL_DIGITS");
                r.put("digits", rs.wasNull() ? null : digits);
                r.put("nullable", rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
                r.put("comment", rs.getString("REMARKS"));
                r.put("default", rs.getString("COLUMN_DEF"));
                String auto = null;
                try { auto = rs.getString("IS_AUTOINCREMENT"); } catch (SQLException ignored) { }
                r.put("autoIncrement", "YES".equalsIgnoreCase(auto));
                rows.add(r);
            }
        }
        return rows;
    }

    private static List<Map<String, Object>> keys(String schema, List<String> tables) throws SQLException {
        DatabaseMetaData md = conn.getMetaData();
        String cat = catalogFor(schema);
        String sch = schemaFor(schema);
        List<Map<String, Object>> rows = new ArrayList<>();
        for (String table : tables) {
            List<Object[]> pk = new ArrayList<>();
            try (ResultSet rs = md.getPrimaryKeys(cat, sch, table)) {
                while (rs.next()) {
                    pk.add(new Object[] { rs.getShort("KEY_SEQ"), rs.getString("COLUMN_NAME"), rs.getString("PK_NAME") });
                }
            }
            pk.sort((a, b) -> Short.compare((Short) a[0], (Short) b[0]));
            for (Object[] p : pk) {
                rows.add(row(table, "p", p[2] == null ? "PK_" + table : (String) p[2], (String) p[1], null, null, null));
            }

            List<Object[]> fks = new ArrayList<>();
            try (ResultSet rs = md.getImportedKeys(cat, sch, table)) {
                // Unnamed constraints (e.g. SQLite): a KEY_SEQ of 1 starts a new foreign key.
                int unnamed = 0;
                String lastGenerated = null;
                while (rs.next()) {
                    String refSchema = useCatalogs ? rs.getString("PKTABLE_CAT") : rs.getString("PKTABLE_SCHEM");
                    String name = rs.getString("FK_NAME");
                    if (name == null || name.isEmpty()) {
                        if (rs.getShort("KEY_SEQ") <= 1 || lastGenerated == null) {
                            lastGenerated = "FK_" + table + "_" + rs.getString("PKTABLE_NAME") + "_" + (++unnamed);
                        }
                        name = lastGenerated;
                    }
                    fks.add(new Object[] { name, rs.getShort("KEY_SEQ"), rs.getString("FKCOLUMN_NAME"),
                        refSchema == null ? schema : refSchema, rs.getString("PKTABLE_NAME"), rs.getString("PKCOLUMN_NAME") });
                }
            }
            fks.sort((a, b) -> {
                int c = ((String) a[0]).compareTo((String) b[0]);
                return c != 0 ? c : Short.compare((Short) a[1], (Short) b[1]);
            });
            for (Object[] f : fks) {
                rows.add(row(table, "f", (String) f[0], (String) f[2], (String) f[3], (String) f[4], (String) f[5]));
            }

            List<Object[]> uks = new ArrayList<>();
            try (ResultSet rs = md.getIndexInfo(cat, sch, table, true, true)) {
                while (rs.next()) {
                    if (rs.getShort("TYPE") == DatabaseMetaData.tableIndexStatistic || rs.getString("COLUMN_NAME") == null) {
                        continue;
                    }
                    uks.add(new Object[] { rs.getString("INDEX_NAME"), rs.getShort("ORDINAL_POSITION"), rs.getString("COLUMN_NAME") });
                }
            } catch (SQLException ignored) {
                // Some drivers do not support index metadata for views; unique keys are optional.
            }
            uks.sort((a, b) -> {
                int c = String.valueOf(a[0]).compareTo(String.valueOf(b[0]));
                return c != 0 ? c : Short.compare((Short) a[1], (Short) b[1]);
            });
            for (Object[] u : uks) {
                rows.add(row(table, "u", String.valueOf(u[0]), (String) u[2], null, null, null));
            }
        }
        return rows;
    }

    private static Map<String, Object> row(String table, String type, String name, String column,
                                           String refSchema, String refTable, String refColumn) {
        Map<String, Object> r = new LinkedHashMap<>();
        r.put("table", table);
        r.put("type", type);
        r.put("name", name);
        r.put("column", column);
        r.put("refSchema", refSchema);
        r.put("refTable", refTable);
        r.put("refColumn", refColumn);
        return r;
    }

    /** Minimal JSON reader/writer: objects, arrays, strings, numbers, booleans, null. */
    static final class Json {
        private final String s;
        private int i;

        Json(String s) {
            this.s = s;
        }

        Object parse() {
            Object v = value();
            ws();
            if (i != s.length()) {
                throw new IllegalArgumentException("Trailing characters in JSON at " + i);
            }
            return v;
        }

        private void ws() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
        }

        private Object value() {
            ws();
            if (i >= s.length()) {
                throw new IllegalArgumentException("Unexpected end of JSON");
            }
            char c = s.charAt(i);
            if (c == '{') {
                Map<String, Object> m = new LinkedHashMap<>();
                i++;
                ws();
                if (s.charAt(i) == '}') {
                    i++;
                    return m;
                }
                while (true) {
                    ws();
                    String k = string();
                    ws();
                    expect(':');
                    m.put(k, value());
                    ws();
                    if (s.charAt(i) == ',') {
                        i++;
                    } else {
                        expect('}');
                        return m;
                    }
                }
            }
            if (c == '[') {
                List<Object> l = new ArrayList<>();
                i++;
                ws();
                if (s.charAt(i) == ']') {
                    i++;
                    return l;
                }
                while (true) {
                    l.add(value());
                    ws();
                    if (s.charAt(i) == ',') {
                        i++;
                    } else {
                        expect(']');
                        return l;
                    }
                }
            }
            if (c == '"') {
                return string();
            }
            if (s.startsWith("true", i)) {
                i += 4;
                return Boolean.TRUE;
            }
            if (s.startsWith("false", i)) {
                i += 5;
                return Boolean.FALSE;
            }
            if (s.startsWith("null", i)) {
                i += 4;
                return null;
            }
            int start = i;
            while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) {
                i++;
            }
            String num = s.substring(start, i);
            if (num.isEmpty()) {
                throw new IllegalArgumentException("Unexpected character in JSON at " + start);
            }
            return num.contains(".") || num.contains("e") || num.contains("E") ? (Object) Double.parseDouble(num) : (Object) Long.parseLong(num);
        }

        private void expect(char c) {
            if (i >= s.length() || s.charAt(i) != c) {
                throw new IllegalArgumentException("Expected '" + c + "' in JSON at " + i);
            }
            i++;
        }

        private String string() {
            expect('"');
            StringBuilder sb = new StringBuilder();
            while (true) {
                char c = s.charAt(i++);
                if (c == '"') {
                    return sb.toString();
                }
                if (c == '\\') {
                    char e = s.charAt(i++);
                    switch (e) {
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'u': sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; break;
                        default: sb.append(e);
                    }
                } else {
                    sb.append(c);
                }
            }
        }

        @SuppressWarnings("unchecked")
        static void write(Object v, StringBuilder sb) {
            if (v == null) {
                sb.append("null");
            } else if (v instanceof String) {
                sb.append('"');
                String str = (String) v;
                for (int k = 0; k < str.length(); k++) {
                    char c = str.charAt(k);
                    switch (c) {
                        case '"': sb.append("\\\""); break;
                        case '\\': sb.append("\\\\"); break;
                        case '\n': sb.append("\\n"); break;
                        case '\r': sb.append("\\r"); break;
                        case '\t': sb.append("\\t"); break;
                        default:
                            if (c < 0x20) {
                                sb.append(String.format("\\u%04x", (int) c));
                            } else {
                                sb.append(c);
                            }
                    }
                }
                sb.append('"');
            } else if (v instanceof Number || v instanceof Boolean) {
                sb.append(v);
            } else if (v instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<String, Object> e : ((Map<String, Object>) v).entrySet()) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    write(e.getKey(), sb);
                    sb.append(':');
                    write(e.getValue(), sb);
                }
                sb.append('}');
            } else if (v instanceof List) {
                sb.append('[');
                boolean first = true;
                for (Object o : (List<Object>) v) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    write(o, sb);
                }
                sb.append(']');
            } else {
                write(String.valueOf(v), sb);
            }
        }
    }
}

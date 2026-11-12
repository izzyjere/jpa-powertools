import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.hibernate.SessionFactory;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistry;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;
import org.hibernate.engine.spi.SessionFactoryImplementor;

/**
 * Asks Hibernate 6 whether each query is valid HQL/JPQL for the given entities (no database needed).
 * Args: classesDir package queriesFile. Queries are separated by lines containing only "----".
 * Prints one line per query: VALID or INVALID<TAB>message.
 */
public class JpqlCheck {
    public static void main(String[] args) throws Exception {
        File classes = new File(args[0]);
        String pkg = args[1];
        String[] queries = Files.readString(Path.of(args[2]), StandardCharsets.UTF_8).split("\\R----\\R");
        StandardServiceRegistry registry = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.dialect", "org.hibernate.dialect.PostgreSQLDialect")
            .applySetting("hibernate.boot.allow_jdbc_metadata_access", "false")
            .applySetting("hibernate.hbm2ddl.auto", "none")
            .build();
        ClassLoader loader = new URLClassLoader(new URL[] { classes.toURI().toURL() }, JpqlCheck.class.getClassLoader());
        Thread.currentThread().setContextClassLoader(loader);
        MetadataSources sources = new MetadataSources(registry);
        File dir = new File(classes, pkg.replace('.', File.separatorChar));
        for (File f : dir.listFiles()) {
            String n = f.getName();
            if (n.endsWith(".class") && !n.contains("$")) {
                sources.addAnnotatedClass(Class.forName(pkg + "." + n.substring(0, n.length() - 6), true, loader));
            }
        }
        try (SessionFactory sf = sources.buildMetadata().buildSessionFactory()) {
            var engine = ((SessionFactoryImplementor) sf).getQueryEngine();
            for (String q : queries) {
                try {
                    engine.getHqlTranslator().translate(q.trim(), null);
                    System.out.println("VALID");
                } catch (Exception e) {
                    String msg = String.valueOf(e.getMessage()).replace('\n', ' ').replace('\r', ' ');
                    System.out.println("INVALID\t" + msg);
                }
            }
        }
    }
}

import java.io.File;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.List;
import org.hibernate.SessionFactory;
import org.hibernate.boot.MetadataSources;
import org.hibernate.boot.registry.StandardServiceRegistry;
import org.hibernate.boot.registry.StandardServiceRegistryBuilder;

/** Boots Hibernate with hbm2ddl=validate for every compiled entity. Args: url user password classesDir package */
public class HibernateValidate {
    public static void main(String[] args) throws Exception {
        String url = args[0], user = args[1], password = args[2];
        File classes = new File(args[3]);
        String pkg = args[4];
        StandardServiceRegistry registry = new StandardServiceRegistryBuilder()
            .applySetting("hibernate.connection.url", url)
            .applySetting("hibernate.connection.username", user)
            .applySetting("hibernate.connection.password", password)
            .applySetting("hibernate.hbm2ddl.auto", "validate")
            .applySetting("hibernate.connection.pool_size", "1")
            .build();
        ClassLoader loader = new URLClassLoader(new URL[] { classes.toURI().toURL() }, HibernateValidate.class.getClassLoader());
        Thread.currentThread().setContextClassLoader(loader);
        MetadataSources sources = new MetadataSources(registry);
        List<String> names = new ArrayList<>();
        File dir = new File(classes, pkg.replace('.', File.separatorChar));
        for (File f : dir.listFiles()) {
            String n = f.getName();
            if (n.endsWith(".class") && !n.contains("$")) {
                Class<?> c = Class.forName(pkg + "." + n.substring(0, n.length() - 6), true, loader);
                if (c.isAnnotationPresent(jakarta.persistence.Entity.class)) {
                    sources.addAnnotatedClass(c);
                    names.add(c.getSimpleName());
                }
            }
        }
        try (SessionFactory sf = sources.buildMetadata().buildSessionFactory()) {
            System.out.println("VALID " + names.size() + " entities: " + String.join(", ", names));
        }
    }
}

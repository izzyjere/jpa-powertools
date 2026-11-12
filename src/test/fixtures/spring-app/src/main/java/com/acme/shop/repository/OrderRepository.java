package com.acme.shop.repository;

import com.acme.shop.domain.PurchaseOrder;
import org.springframework.data.domain.Page;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.math.BigDecimal;
import java.util.List;

public interface OrderRepository extends JpaRepository<PurchaseOrder, Long> {

    List<PurchaseOrder> findByCustomerEmailOrderByPlacedAtDesc(String email);

    long countByStatus(PurchaseOrder.OrderStatus status);

    @Query(value = "select o from Order o left join fetch o.items i where o.total >= ?1",
           countQuery = "select count(o) from Order o where o.total >= ?1")
    Page<PurchaseOrder> findLargeOrders(BigDecimal minimum, Pageable pageable);

    @Query(value = "SELECT * FROM orders WHERE total > 0", nativeQuery = true)
    List<PurchaseOrder> nativeAllOrders();

    @Query("select new com.acme.shop.repository.OrderTotals(o.customer.email, sum(o.total)) "
         + "from Order o group by o.customer.email having sum(o.total) > :min")
    List<OrderTotals> totalsAbove(BigDecimal min);
}

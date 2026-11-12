package com.acme.shop.repository;

import com.acme.shop.domain.Customer;
import com.acme.shop.domain.CustomerStatus;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;

public interface CustomerRepository extends JpaRepository<Customer, Long> {

    Optional<Customer> findByEmailIgnoreCase(String email);

    List<Customer> findByAddressCityAndStatusOrderByFullNameAsc(String city, CustomerStatus status);

    @Query("select c from Customer c where c.address.city = :city and size(c.orders) > :minOrders")
    List<Customer> findLoyalCustomers(@Param("city") String city, @Param("minOrders") int minOrders);

    @Query("""
            select distinct c
            from Customer c
              join c.orders o
            where o.status = com.acme.shop.domain.PurchaseOrder.OrderStatus.PAID
              and c.status = :status
            """)
    List<Customer> findPayingCustomers(@Param("status") CustomerStatus status);
}

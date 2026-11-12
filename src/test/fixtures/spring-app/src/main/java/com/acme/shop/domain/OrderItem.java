package com.acme.shop.domain;

import jakarta.persistence.Entity;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;

@Entity
@Table(name = "order_items")
public class OrderItem extends BaseEntity {

    @ManyToOne
    private PurchaseOrder order;

    @ManyToOne
    private Product product;

    private int quantity;
}

package com.acme.shop.domain;

import jakarta.persistence.ElementCollection;
import jakarta.persistence.Entity;
import jakarta.persistence.Table;

import java.math.BigDecimal;
import java.util.HashSet;
import java.util.Set;

@Entity
@Table(name = "products")
public class Product extends BaseEntity {

    private String sku;

    private String title;

    private BigDecimal price;

    @ElementCollection
    private Set<String> tags = new HashSet<>();
}
